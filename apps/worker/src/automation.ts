import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';

import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { completeBaselineSkippedRepair, ensureBaselineSchemaRule } from './baseline-automation';
import { fromBase64Url } from './encoding';
import { buildAiEventDetailsRequest, type AiEventDetailsRequest, type EventDetails, type MailExtraction, type TaskRoleDescription } from './event-details';
import { calendarEventDescription } from './event-description';
import type { AttachmentLink } from './event-description';
import {
  attributedMessageId,
  buildEventCorrespondenceRequest,
  changedCalendarFields,
  invitedAttendees,
  partitionByRefreshWindow,
  refreshPlan,
  refreshSearchWindow,
  sourceMessageAttribution,
} from './event-refresh';
import type {
  AiEventCorrespondenceRequest,
  CalendarAttendee,
  CalendarEventFields,
  DesiredCalendarFields,
  EventCorrespondence,
  RefreshPlan,
} from './event-refresh';
import { writeRecoveryReceipt } from './recovery-receipts';
import { resolveSourceMessageFolder } from './attachment-folders';
import { createTaskWorkflow } from './tasks';
import { activeMemberInvitees, deliverLineBatch, deliverSourceMessageEmail, recordDeliveryAttempt, recordEventInvitations } from './delivery';
import type { PublishedDriveAttachment, SourceAttachment, SourceAttachmentContent } from './drive-attachments';
import { GoogleGrantRejectedError } from './google';
import type { GoogleTokenSet } from './google';
import {
  administratorEmails,
  alertAdministrators,
  automationAlertMessage,
  AutomationConfigurationError,
  classifyAutomationFailure,
  shouldAlertAdministrators,
} from './health';
import { productionAutomationDependencies } from './automation/providers';
import { GoogleApiError } from './automation/providers';
import type { AutomationDependencies, GoogleAutomationPort } from './automation/providers';
import { AGENT_TRANSCRIPT_RETENTION_DAYS, AgentRunFailure, expireProposedActions, runAgent, writeAgentRunTranscript } from './agent-runs';
import type { AgentExecutionMode, AgentWritePort } from './agent-runs';
import { createDatabaseAccess } from './database-access';
import type { Bindings } from './types';
import { validateAttachmentIntake } from '@mail/domain';
import { convertAttachmentsForEventExtraction, type ConvertedAttachment } from './attachment-conversion';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizationKeys, organizations } from './storage/control-schema';
import {
  agentRules,
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRuns,
  connections,
  deliveries,
  automationWarnings,
  eventAttachments,
  events,
  exceptions as automationExceptions,
  googleConnections,
  listItems,
  operationalTaskRoles,
  prompts,
  rulePermittedLineLists,
  rulePermittedRecipientLists,
  rules as automationRules,
  sourceMessages,
} from './storage/organization-schema';
import type { GoogleConnectionRecord } from './storage/organization-schema';

/** Stands in for a publication that never ran because no Drive folder was available. */
const unpublishedAttachment: PublishedDriveAttachment = { outcome: 'failed', driveFileId: null, publicUrl: null };

interface GmailHistory {
  historyId?: string;
  nextPageToken?: string;
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
}

interface GmailMessage {
  id?: string;
  labelIds?: string[];
  payload?: GmailPart;
  snippet?: string;
  /** Gmail's delivery timestamp as epoch milliseconds. */
  internalDate?: string;
}

interface GmailMessageList {
  messages?: Array<{ id?: string }>;
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface CalendarEvent {
  id?: string;
}

interface CalendarTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface CalendarEventResource extends CalendarEvent {
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  attendees?: CalendarAttendee[];
}

interface CalendarEventList {
  items?: CalendarEventResource[];
}

type AutomationInbox = GoogleConnectionRecord;

export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

export const LEGACY_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export interface MailboxTestMatch {
  id: string;
  subject: string;
  sender: string;
}

export interface MailboxTestSource extends MailboxTestMatch {
  source: string;
  attachments: SourceAttachmentContent[];
  receivedAt?: string;
}

export interface ActiveRule {
  id: string;
  priority: number;
  selectionPolicy: Record<string, unknown>;
  taskRoleIds?: string[];
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
}

interface ActiveAgentRule {
  id: string;
  priority: number;
  promptId: string;
  revision: number;
  selectionPolicy: Record<string, unknown>;
  executionMode: AgentExecutionMode;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
}

export interface RuleSource {
  sender: string;
  subject: string;
  body: string;
  labels?: string[];
}

const now = (): string => new Date().toISOString();

const productionDependencies = productionAutomationDependencies;

const mimeTypeOf = (part: GmailPart): string => (part.mimeType ?? '').toLowerCase();

const decodedPartText = (part: GmailPart): string => {
  if (!part.body?.data) return '';
  const text = new TextDecoder().decode(fromBase64Url(part.body.data));
  return mimeTypeOf(part).startsWith('text/html') ? text.replace(/<[^>]*>/gu, ' ') : text;
};

/**
 * Picks one representation of a multipart/alternative body. Both representations
 * carry the same text, so decoding both would send every sentence to the AI twice.
 */
const preferredAlternative = (parts: GmailPart[]): GmailPart[] => {
  const plain = parts.find((part) => mimeTypeOf(part).startsWith('text/plain'));
  if (plain) return [plain];
  const html = parts.find((part) => mimeTypeOf(part).startsWith('text/html'));
  if (html) return [html];
  return parts.slice(-1);
};

const bodyTextParts = (part: GmailPart): string[] => {
  const children = part.parts ?? [];
  const selected = mimeTypeOf(part) === 'multipart/alternative' ? preferredAlternative(children) : children;
  return [decodedPartText(part), ...selected.flatMap(bodyTextParts)];
};

/** Reads the Source Message body once, whichever representations Gmail supplies. */
export const decodedBody = (part: GmailPart | undefined): string => {
  if (!part) return '';
  return bodyTextParts(part).join('\n').replace(/\s+/gu, ' ').trim();
};

const requireActiveAiConnection = async (database: D1Database): Promise<void> => {
  const connection = await drizzleOrganizationDatabase(database).select({ id: connections.id }).from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new AutomationConfigurationError('自動化を実行する前に OpenAI 互換 API を設定してください。');
};

/**
 * States when the Source Message arrived, in the time zone this product schedules
 * in, so the AI can resolve a date that omits its year. Gmail reports epoch
 * milliseconds; an absent or unparseable value yields no fact at all rather than a
 * guessed one.
 */
export const receivedAtOf = (internalDate: string | undefined): string | undefined => {
  if (!internalDate || !/^\d+$/u.test(internalDate)) return undefined;
  const received = new Date(Number(internalDate) + 9 * 60 * 60 * 1_000);
  if (!Number.isFinite(received.getTime())) return undefined;
  return `${received.toISOString().slice(0, 19)}+09:00`;
};

/** Returns declared attachment byte sizes, excluding inline message body parts. */
export const sourceAttachmentSizes = (part: GmailPart | undefined): number[] => {
  if (!part) return [];
  const own = (part.filename || part.body?.attachmentId) && Number.isFinite(part.body?.size) ? [part.body?.size ?? 0] : [];
  return [...own, ...(part.parts?.flatMap(sourceAttachmentSizes) ?? [])];
};

/** Lists only Gmail file parts that can be copied safely after intake validation. */
export const sourceAttachments = (part: GmailPart | undefined): Array<{ attachmentId: string; filename: string; mimeType: string; size: number }> => {
  if (!part) return [];
  const own = part.filename && part.body?.attachmentId
    ? [{ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 }]
    : [];
  return [...own, ...(part.parts?.flatMap(sourceAttachments) ?? [])];
};

const subjectOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'subject')?.value?.trim() ?? '(件名なし)';

const senderOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value?.trim() ?? '';

const ruleMatches = (rule: Pick<ActiveRule, 'selectionPolicy'>, source: RuleSource): boolean => {
  const sender = source.sender.trim().toLowerCase();
  const domain = sender.split('@')[1] ?? '';
  const content = `${source.subject}\n${source.body}`.toLowerCase();
  const policy = rule.selectionPolicy;
  const requiredSender = typeof policy.sender === 'string' ? policy.sender.trim().toLowerCase() : '';
  const requiredDomain = typeof policy.domain === 'string' ? policy.domain.trim().toLowerCase() : '';
  const requiredKeyword = typeof policy.keyword === 'string' ? policy.keyword.trim().toLowerCase() : '';
  const requiredLabel = typeof policy.label === 'string' ? policy.label.trim() : '';
  return (!requiredSender || requiredSender === sender)
    && (!requiredDomain || requiredDomain === domain)
    && (!requiredKeyword || content.includes(requiredKeyword))
    && (!requiredLabel || (source.labels ?? []).includes(requiredLabel));
};

/** Chooses exactly one active Rule, using descending priority after policy matching. */
export const selectActiveRule = (rules: ActiveRule[], source: RuleSource): ActiveRule | null => {
  const matching = rules.filter((rule) => ruleMatches(rule, source));
  return matching.sort((left, right) => right.priority - left.priority)[0] ?? null;
};

const organizationKeyFor = async (env: Bindings, organizationId: string): Promise<CryptoKey> => {
  const record = await drizzleControlDatabase(env.CONTROL_DB).select({
    masterKeyVersion: organizationKeys.masterKeyVersion,
    wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
  }).from(organizationKeys).where(eq(organizationKeys.organizationId, organizationId)).get();
  if (!record) throw new Error('Organization encryption key is missing.');
  return unwrapOrganizationKey({ masterKeyVersion: record.masterKeyVersion, envelope: JSON.parse(record.wrappedKeyEnvelope) }, await masterKey(env.CREDENTIAL_MASTER_KEY), organizationId);
};

/**
 * Refreshing well ahead of expiry buys two things unattended operation needs: a
 * transient token-endpoint outage can be ridden out on the token already in
 * hand, and a rejected grant still leaves a live token for the Administrator
 * notice that reports it.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 15 * 60 * 1_000;

/** Below this the stored token can no longer be trusted to carry one request. */
const ACCESS_TOKEN_USABLE_MARGIN_MS = 60_000;

const storedInboxToken = async (
  env: Bindings,
  organizationId: string,
  inbox: AutomationInbox,
): Promise<{ key: CryptoKey; token: GoogleTokenSet }> => {
  const key = await organizationKeyFor(env, organizationId);
  const token = JSON.parse(await decrypt(JSON.parse(inbox.tokenEnvelope), key, `google-connection:${organizationId}:automation-inbox`)) as GoogleTokenSet;
  return { key, token };
};

const accessTokenForInbox = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
  dependencies: AutomationDependencies,
): Promise<string> => {
  const { key, token } = await storedInboxToken(env, organizationId, inbox);
  const remaining = Date.parse(token.expiresAt) - Date.now();
  if (remaining > ACCESS_TOKEN_REFRESH_MARGIN_MS) return token.accessToken;
  let refreshed: GoogleTokenSet;
  try {
    refreshed = await dependencies.tokens.refresh({
      refreshToken: token.refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
  } catch (error) {
    if (error instanceof GoogleGrantRejectedError || remaining <= ACCESS_TOKEN_USABLE_MARGIN_MS) throw error;
    return token.accessToken;
  }
  const envelope = await encrypt(JSON.stringify(refreshed), key, `google-connection:${organizationId}:automation-inbox`);
  await drizzleOrganizationDatabase(database).update(googleConnections)
    .set({ tokenEnvelope: JSON.stringify(envelope), updatedAt: now() })
    .where(eq(googleConnections.id, inbox.id))
    .run();
  return refreshed.accessToken;
};

/** The stored access token when it can still carry the Administrator notice, otherwise nothing. */
const notifiableAccessToken = async (
  env: Bindings,
  organizationId: string,
  inbox: AutomationInbox,
): Promise<string | null> => {
  try {
    const { token } = await storedInboxToken(env, organizationId, inbox);
    return Date.parse(token.expiresAt) - Date.now() > ACCESS_TOKEN_USABLE_MARGIN_MS ? token.accessToken : null;
  } catch {
    return null;
  }
};

/**
 * Records one failed Automation run and, once the failure has outlived its
 * retry budget, mails every Administrator through the Automation Inbox. Only a
 * grant Google rejected suspends the Inbox; every other failure leaves it
 * active so the next scheduled run retries without anyone signing in.
 */
const recordAutomationFailure = async (input: {
  env: Bindings;
  organizationId: string;
  database: D1Database;
  inbox: AutomationInbox;
  error: unknown;
  dependencies: AutomationDependencies;
}): Promise<void> => {
  const db = drizzleOrganizationDatabase(input.database);
  const kind = classifyAutomationFailure(input.error);
  const lastError = input.error instanceof Error ? input.error.message : 'Automation Inbox failed.';
  const at = now();
  const failingSince = input.inbox.failingSince ?? at;
  await db.update(googleConnections).set({
    ...(kind === 'credential' ? { status: 'reauthentication_required' as const } : {}),
    lastError,
    failingSince,
    updatedAt: at,
  }).where(eq(googleConnections.id, input.inbox.id)).run();
  if (!shouldAlertAdministrators({ kind, failingSince, alertedAt: input.inbox.alertedAt, at })) return;
  try {
    const [destinations, accessToken] = await Promise.all([
      administratorEmails(input.env, input.organizationId),
      notifiableAccessToken(input.env, input.organizationId, input.inbox),
    ]);
    if (!destinations.length || !accessToken) return;
    const message = automationAlertMessage({
      kind,
      inboxAddress: input.inbox.inboxAddress,
      failingSince,
      lastError,
      appUrl: input.env.APP_URL,
    });
    const delivered = await alertAdministrators({
      google: input.dependencies.google,
      accessToken,
      destinations,
      subject: message.subject,
      body: message.body,
    });
    if (!delivered) return;
    await db.update(googleConnections).set({ alertedAt: at, updatedAt: at })
      .where(eq(googleConnections.id, input.inbox.id)).run();
  } catch {
    // An undelivered notice stays unrecorded, so the next scheduled run retries it.
  }
};

const verifyOrganizationInboxCredentialWithDependencies = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  dependencies: AutomationDependencies,
): Promise<void> => {
  const db = drizzleOrganizationDatabase(database);
  const inbox = await db.select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
  )).limit(1).get();
  if (!inbox) return;
  try {
    await accessTokenForInbox(env, organizationId, database, inbox, dependencies);
  } catch (error) {
    await recordAutomationFailure({ env, organizationId, database, inbox, error, dependencies });
  }
};

interface AiCredential {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface LineCredential {
  channelAccessToken?: string;
}

const lineAccessToken = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
): Promise<string | null> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'line'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) return null;
  try {
    const key = await organizationKeyFor(env, organizationId);
    const credential = JSON.parse(await decrypt(
      JSON.parse(connection.credential),
      key,
      `organization-connection:${organizationId}:line`,
    )) as LineCredential;
    return credential.channelAccessToken?.trim() || null;
  } catch {
    return null;
  }
};

/** Resolves one Rule's configured readers and delivers one Source Message-level notice to each destination. */
const deliverSourceMessageNotice = async (input: {
  dependencies: AutomationDependencies;
  env: Bindings;
  database: D1Database;
  organizationId: string;
  googleAccessToken: string;
  sourceMessageId: string;
  rule: ActiveRule;
  subject: string;
  body: string;
}): Promise<void> => {
  const db = drizzleOrganizationDatabase(input.database);
  const permittedRecipientListIds = input.rule.permittedRecipientListIds ?? [];
  if (permittedRecipientListIds.length) {
    const recipients = await db.select({ destination: listItems.value }).from(listItems).where(and(
      inArray(listItems.listId, permittedRecipientListIds),
      eq(listItems.enabled, true),
    )).all();
    await Promise.all([...new Set(recipients.map(({ destination }) => destination))].map((destination) => deliverSourceMessageEmail({
      database: input.database,
      google: input.dependencies.google,
      accessToken: input.googleAccessToken,
      sourceMessageId: input.sourceMessageId,
      destination,
      subject: input.subject,
      body: input.body,
    })));
  }
  const permittedLineListIds = input.rule.permittedLineListIds ?? [];
  if (!permittedLineListIds.length) return;
  const accessToken = await lineAccessToken(input.env, input.organizationId, input.database);
  if (!accessToken) return;
  const destinations = await db.select({ destinationId: listItems.value }).from(listItems).where(and(
    inArray(listItems.listId, permittedLineListIds),
    eq(listItems.enabled, true),
  )).all();
  await Promise.all([...new Set(destinations.map(({ destinationId }) => destinationId))].map((destinationId) => deliverLineBatch({
    database: input.database,
    accessToken,
    sourceMessageId: input.sourceMessageId,
    destinationId,
    messages: [input.body],
  })));
};

/** Uses the Organization-scoped OpenAI-compatible connection when it is configured. */
const aiExtraction = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
  convertedAttachments: ConvertedAttachment[] | undefined,
  taskRoles: TaskRoleDescription[],
  receivedAt: string | undefined,
  dependencies: AutomationDependencies,
): Promise<MailExtraction | null | undefined> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) return undefined;
  try {
    const key = await organizationKeyFor(env, organizationId);
    const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as AiCredential;
    if (!credential.apiKey || !credential.model) return null;
    return dependencies.ai.extract({
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL,
      model: credential.model,
      source,
      attachments,
      ...(convertedAttachments === undefined ? {} : { convertedAttachments }),
      ...(receivedAt === undefined ? {} : { receivedAt }),
      taskRoles,
      markdown: env.AI,
    });
  } catch {
    return null;
  }
};

const agentConnection = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
): Promise<{ apiKey: string; baseUrl: string; model: string }> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new Error('Agent Rule requires an active AI Connection.');
  const key = await organizationKeyFor(env, organizationId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as AiCredential;
  if (!credential.apiKey || !credential.model) throw new Error('Agent Rule requires a configured AI model.');
  return { apiKey: credential.apiKey, baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL, model: credential.model };
};

const createAgentWritePort = (input: {
  dependencies: AutomationDependencies;
  env: Bindings;
  database: D1Database;
  organizationId: string;
  sourceMessageId: string;
  agentRuleId: string;
  googleAccessToken: string;
}): AgentWritePort => ({
  sendLine: async ({ destination, message }) => {
    const accessToken = await lineAccessToken(input.env, input.organizationId, input.database);
    if (!accessToken) return recordDeliveryAttempt(input.database, { sourceMessageId: input.sourceMessageId, destination, channel: 'line', outcome: 'failed', externalId: null });
    return (await deliverLineBatch({ database: input.database, accessToken, sourceMessageId: input.sourceMessageId, destinationId: destination, messages: [message] }))[0];
  },
  createScheduledEvent: async (arguments_) => {
    const database = drizzleOrganizationDatabase(input.database);
    const eventId = crypto.randomUUID();
    let googleEventId: string | null = null;
    let outcome: 'succeeded' | 'failed' = 'failed';
    try {
      const created = await input.dependencies.google.request<CalendarEvent>(input.googleAccessToken, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        body: JSON.stringify({
          summary: arguments_.title,
          description: arguments_.description ?? '',
          location: arguments_.location ?? '',
          start: { dateTime: arguments_.startsAt },
          end: { dateTime: arguments_.endsAt },
          attendees: [{ email: arguments_.destination }],
        }),
      });
      if (!created.id) throw new Error('Google Calendar did not return an event ID.');
      googleEventId = created.id;
      outcome = 'succeeded';
    } catch {
      outcome = 'failed';
    }
    await database.insert(events).values({
      id: eventId, organizationId: input.organizationId, ruleId: null, agentRuleId: input.agentRuleId,
      sourceMessageId: input.sourceMessageId, googleEventId, title: arguments_.title,
      startsAt: arguments_.startsAt, endsAt: arguments_.endsAt, location: arguments_.location ?? '',
      description: arguments_.description ?? '', status: outcome === 'succeeded' ? 'scheduled' : 'exception',
      createdAt: now(), updatedAt: now(),
    }).run();
    const delivery = await recordDeliveryAttempt(input.database, { eventId, sourceMessageId: input.sourceMessageId, destination: arguments_.destination, channel: 'calendar', outcome, externalId: googleEventId });
    return delivery;
  },
});

export const agentWritePortForApproval = async (input: {
  env: Bindings;
  database: D1Database;
  organizationId: string;
  sourceMessageId: string;
  agentRuleId: string;
}): Promise<AgentWritePort> => {
  const inbox = await drizzleOrganizationDatabase(input.database).select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'), eq(googleConnections.status, 'active'),
  )).limit(1).get();
  if (!inbox) throw new Error('Automation Inbox is not available.');
  const googleAccessToken = await accessTokenForInbox(input.env, input.organizationId, input.database, inbox, productionDependencies);
  return createAgentWritePort({ ...input, dependencies: productionDependencies, googleAccessToken });
};

const runMatchingAgentRules = async (input: {
  dependencies: AutomationDependencies;
  env: Bindings;
  database: D1Database;
  organizationId: string;
  sourceMessageId: string;
  sender: string;
  subject: string;
  body: string;
  attachments: ConvertedAttachment[];
  googleAccessToken: string;
  rules: ActiveAgentRule[];
}): Promise<boolean> => {
  if (!input.rules.length) return false;
  const database = drizzleOrganizationDatabase(input.database);
  let connection: { apiKey: string; baseUrl: string; model: string } | null = null;
  let connectionError: string | null = null;
  try {
    connection = await agentConnection(input.env, input.organizationId, input.database);
  } catch (error) {
    connectionError = error instanceof Error ? error.message : 'Agent Rule AI Connection failed.';
  }
  const organizationKey = await organizationKeyFor(input.env, input.organizationId);
  let failed = false;
  for (const rule of input.rules) {
    const runId = crypto.randomUUID();
    const startedAt = now();
    const source = { id: input.sourceMessageId, sender: input.sender, subject: input.subject, body: input.body, attachments: input.attachments };
    let runResult: Awaited<ReturnType<typeof runAgent>> | null = null;
    let runError: string | null = null;
    let promptRevision = 0;
    try {
      const prompt = await database.select({ instructions: prompts.instructions, revision: prompts.currentRevision }).from(prompts)
        .where(eq(prompts.id, rule.promptId)).get();
      if (!prompt) throw new Error('Agent Rule Prompt was not found.');
      promptRevision = prompt.revision;
      if (!connection) throw new Error(connectionError ?? 'Agent Rule AI Connection failed.');
      const [recipientRows, lineRows] = await Promise.all([
        rule.permittedRecipientListIds.length ? database.select({ destination: listItems.value }).from(listItems).where(and(inArray(listItems.listId, rule.permittedRecipientListIds), eq(listItems.enabled, true))).all() : [],
        rule.permittedLineListIds.length ? database.select({ destination: listItems.value }).from(listItems).where(and(inArray(listItems.listId, rule.permittedLineListIds), eq(listItems.enabled, true))).all() : [],
      ]);
      const permittedRecipientDestinations = [...new Set(recipientRows.map(({ destination }) => destination))];
      const permittedLineDestinations = [...new Set(lineRows.map(({ destination }) => destination))];
      const writes = createAgentWritePort({
        dependencies: input.dependencies, env: input.env, database: input.database,
        organizationId: input.organizationId, sourceMessageId: input.sourceMessageId,
        agentRuleId: rule.id, googleAccessToken: input.googleAccessToken,
      });
      runResult = await runAgent({
        database: input.database,
        runId,
        agentRuleId: rule.id,
        model: input.dependencies.agent,
        connection,
        prompt: prompt.instructions,
        source,
        executionMode: rule.executionMode,
        permittedRecipientDestinations,
        permittedLineDestinations,
        writes,
      });
    } catch (error) {
      if (error instanceof AgentRunFailure) runResult = error.result;
      runError = error instanceof Error ? error.message : 'Agent Rule run failed.';
      failed = true;
    }
    const completedAt = now();
    try {
      const transcriptKey = await writeAgentRunTranscript({
        bucket: input.env.RECOVERY_RECEIPTS,
        organizationKey,
        transcript: {
          runId,
          organizationId: input.organizationId,
          agentRuleId: rule.id,
          agentRuleRevision: rule.revision,
          promptId: rule.promptId,
          promptRevision,
          source,
          messages: runResult?.messages ?? [],
          finalOutput: runResult?.output ?? '',
          error: runError,
        },
      });
      await database.insert(agentRuns).values({
        id: runId,
        agentRuleId: rule.id,
        agentRuleRevision: rule.revision,
        promptId: rule.promptId,
        promptRevision,
        sourceMessageId: input.sourceMessageId,
        model: runResult?.model ?? connection?.model ?? 'unconfigured',
        startedAt,
        completedAt,
        outcome: runError ? 'failed' : 'succeeded',
        toolCallCount: runResult?.toolCallCount ?? 0,
        tokens: runResult?.tokens ?? 0,
        transcriptKey,
        expiresAt: new Date(Date.now() + AGENT_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
      }).run();
    } catch (error) {
      runError = error instanceof Error ? error.message : 'Run Transcript persistence failed.';
      failed = true;
    }
    if (runError) {
      await database.insert(automationExceptions).values({
        id: crypto.randomUUID(),
        sourceMessageId: input.sourceMessageId,
        code: 'agent_rule_run_failed',
        message: runError,
        state: 'open',
        createdAt: now(),
      }).run();
    }
  }
  return failed;
};

/** Reuses the production AI provider for a confirmed, manual Mailbox Test preview. */
const extractMailboxTestPackage = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
  receivedAt: string | undefined,
  dependencies: AutomationDependencies,
): Promise<MailExtraction | null> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new Error('先に OpenAI 互換 API を設定してください。');
  const key = await organizationKeyFor(env, organizationId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as AiCredential;
  if (!credential.apiKey || !credential.model) throw new Error('先に OpenAI 互換 API を設定してください。');
  const taskRoles = await drizzleOrganizationDatabase(database).select({
    id: operationalTaskRoles.id,
    displayName: operationalTaskRoles.displayName,
    description: operationalTaskRoles.description,
  }).from(operationalTaskRoles).all();
  return dependencies.ai.extract({
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL,
    model: credential.model,
    source,
    attachments,
    ...(receivedAt === undefined ? {} : { receivedAt }),
    taskRoles,
    markdown: env.AI,
  });
};

/** Produces the exact bounded OpenAI-compatible payload for review before sending. */
const previewMailboxTestAiRequest = async (
  env: Bindings,
  input: { database: D1Database; source: string; attachments: SourceAttachmentContent[]; receivedAt?: string },
): Promise<AiEventDetailsRequest> => {
  const taskRoles = await drizzleOrganizationDatabase(input.database).select({
    id: operationalTaskRoles.id,
    displayName: operationalTaskRoles.displayName,
    description: operationalTaskRoles.description,
  }).from(operationalTaskRoles).all();
  return buildAiEventDetailsRequest({
    source: input.source,
    attachments: input.attachments,
    ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
    taskRoles,
    markdown: env.AI,
  });
};

const mailboxMessage = async (google: GoogleAutomationPort, accessToken: string, messageId: string): Promise<GmailMessage> =>
  google.request<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`);

/**
 * Folds a subject down to the characters that carry meaning: Unicode-width
 * variants (full-width/half-width) collapse together, and any run of
 * whitespace — including a full-width space — collapses to one. An Admin
 * pasting a subject from Gmail should not have a test fail over an invisible
 * trailing space or a stray full-width character Gmail itself treats as the
 * same subject.
 */
const normalizedSubject = (subject: string): string => subject.normalize('NFKC').trim().replace(/\s+/gu, ' ');

const exactSubject = (subject: string, expected: string): boolean => normalizedSubject(subject) === normalizedSubject(expected);

const activeAutomationInbox = async (database: D1Database): Promise<AutomationInbox> => {
  const inbox = await drizzleOrganizationDatabase(database).select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
  )).limit(1).get();
  if (!inbox) throw new Error('Automation Inbox が見つかりません。');
  return inbox;
};

/** Finds recent exact-subject matches in the Organization's Automation Inbox without changing Gmail state or the history boundary. */
const searchMailboxForTestWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  subject: string,
  dependencies: AutomationDependencies,
): Promise<MailboxTestMatch[]> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  query.searchParams.set('q', `subject:"${subject.replaceAll('"', '\\"')}"`);
  query.searchParams.set('maxResults', '10');
  const results = await dependencies.google.request<GmailMessageList>(accessToken, query.toString());
  const messages = await Promise.all((results.messages ?? []).flatMap((value) => value.id ? [mailboxMessage(dependencies.google, accessToken, value.id)] : []));
  return messages.flatMap((message) => {
    const foundSubject = subjectOf(message.payload);
    if (!message.id || !exactSubject(foundSubject, subject)) return [];
    return [{ id: message.id, subject: foundSubject, sender: senderOf(message.payload) }];
  });
};

export const searchMailboxForTest = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  subject: string,
): Promise<MailboxTestMatch[]> => searchMailboxForTestWithGoogle(env, organizationId, database, subject, productionDependencies);

/** Reads one selected message from the Organization's Automation Inbox for a server-side AI preview. */
const readMailboxTestSourceWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  messageId: string,
  dependencies: AutomationDependencies,
): Promise<MailboxTestSource> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const message = await mailboxMessage(dependencies.google, accessToken, messageId);
  if (!message.id) throw new Error('Gmail メッセージを取得できませんでした。');
  const subject = subjectOf(message.payload);
  const body = decodedBody(message.payload) || (message.snippet ?? '');
  const attachments = sourceAttachments(message.payload);
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const receivedAt = receivedAtOf(message.internalDate);
  return {
    id: message.id,
    subject,
    sender: senderOf(message.payload),
    source: `${subject}\n${body}`,
    attachments: await dependencies.attachments.read({ accessToken, gmailMessageId: message.id, attachments }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  };
};

export const readMailboxTestSource = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  messageId: string,
): Promise<MailboxTestSource> => readMailboxTestSourceWithGoogle(env, organizationId, database, messageId, productionDependencies);

/** Creates a Calendar event only after a separately confirmed, encrypted test preview. */
const createMailboxTestCalendarEventsWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; events: EventDetails[] },
  dependencies: AutomationDependencies,
): Promise<{ eventIds: string[] }> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const message = await mailboxMessage(dependencies.google, accessToken, input.messageId);
  const attachments = sourceAttachments(message.payload);
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const attachmentContents = await dependencies.attachments.read({ accessToken, gmailMessageId: input.messageId, attachments });
  const attachmentFolderId = attachmentContents.length ? await resolveSourceMessageFolder({
    database: drizzleOrganizationDatabase(database),
    drive: dependencies.attachments,
    accessToken,
    subject: subjectOf(message.payload),
    receivedAt: receivedAtOf(message.internalDate) ?? new Date().toISOString(),
  }) : null;
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: attachmentFolderId
      ? await dependencies.attachments.publish({ accessToken, attachment, parentFolderId: attachmentFolderId })
      : unpublishedAttachment,
  })));
  if (publications.some(({ publication }) => publication.outcome === 'failed')) {
    throw new Error('添付ファイルを公開できなかったため、テスト予定を作成しませんでした。');
  }
  const attachmentLinks = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ filename: attachment.filename, url: publication.publicUrl }]
    : []);
  const calendarUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  if (publications.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  const created = await Promise.all(input.events.map(async (details) => {
    const event = await dependencies.google.request<CalendarEvent>(accessToken, calendarUrl.toString(), {
      method: 'POST',
      body: JSON.stringify({
        summary: details.title,
        description: calendarEventDescription({
          summary: details.summary,
          attachments: attachmentLinks,
          attribution: `Mail Automation の手動テストで Gmail メッセージ ${input.messageId} から作成しました。`,
        }),
        location: details.location,
        start: { dateTime: details.startsAt, timeZone: details.timeZone },
        end: { dateTime: details.endsAt, timeZone: details.timeZone },
        attachments: publications.map(({ attachment, publication }) => ({
          fileUrl: publication.publicUrl,
          title: attachment.filename,
          mimeType: attachment.mimeType,
        })),
      }),
    });
    if (!event.id) throw new Error('Google Calendar が予定 ID を返しませんでした。');
    return event.id;
  }));
  return { eventIds: created };
};

export const createMailboxTestCalendarEvent = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; events: EventDetails[] },
): Promise<{ eventIds: string[] }> => createMailboxTestCalendarEventsWithGoogle(env, organizationId, database, input, productionDependencies);

const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const calendarEventFields = (event: CalendarEventResource): CalendarEventFields | null => {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;
  return {
    id: event.id,
    etag: event.etag ?? null,
    title: event.summary ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    startsAt: event.start.dateTime,
    endsAt: event.end.dateTime,
    timeZone: event.start.timeZone ?? '',
  };
};

/** Finds the Scheduled Events this Source Message already produced, by Source Attribution. */
const attributedScheduledEvents = async (
  dependencies: AutomationDependencies,
  accessToken: string,
  messageId: string,
  candidates: EventDetails[],
): Promise<CalendarEventFields[]> => {
  const window = refreshSearchWindow(candidates);
  if (!window) return [];
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set('q', messageId);
  url.searchParams.set('timeMin', window.timeMin);
  url.searchParams.set('timeMax', window.timeMax);
  url.searchParams.set('showDeleted', 'false');
  url.searchParams.set('singleEvents', 'false');
  url.searchParams.set('maxResults', '50');
  const list = await dependencies.google.request<CalendarEventList>(accessToken, url.toString());
  return (list.items ?? []).flatMap((item) => {
    const fields = calendarEventFields(item);
    return fields && attributedMessageId(fields.description) === messageId ? [fields] : [];
  });
};

interface RefreshAttachments {
  links: AttachmentLink[];
  calendar: Array<{ fileUrl: string; title: string; mimeType: string }>;
  /** Accepted attachments no previous run left in the folder; published only when applying. */
  pending: string[];
}

/**
 * Reuses the Public Attachments a previous run already placed in the Source
 * Message's folder, and publishes only what is missing. Planning never uploads.
 */
const resolveRefreshAttachments = async (
  dependencies: AutomationDependencies,
  accessToken: string,
  database: D1Database,
  message: GmailMessage,
  messageId: string,
  publishMissing: boolean,
): Promise<RefreshAttachments> => {
  const attachments = sourceAttachments(message.payload);
  const resolved: RefreshAttachments = { links: [], calendar: [], pending: [] };
  if (!attachments.length) return resolved;
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const db = drizzleOrganizationDatabase(database);
  const known = await db.select({ id: sourceMessages.id, driveFolderId: sourceMessages.driveFolderId })
    .from(sourceMessages).where(eq(sourceMessages.gmailMessageId, messageId)).get();
  const missing: SourceAttachment[] = [];
  for (const attachment of attachments) {
    const found = known?.driveFolderId
      ? await dependencies.attachments.find({ accessToken, filename: attachment.filename, folderId: known.driveFolderId })
      : null;
    if (!found) {
      missing.push(attachment);
      continue;
    }
    resolved.links.push({ filename: attachment.filename, url: found.publicUrl });
    resolved.calendar.push({ fileUrl: found.publicUrl, title: attachment.filename, mimeType: attachment.mimeType });
  }
  if (!missing.length) return resolved;
  if (!publishMissing) return { ...resolved, pending: missing.map((attachment) => attachment.filename) };
  const contents = await dependencies.attachments.read({ accessToken, gmailMessageId: messageId, attachments: missing });
  const folderId = await resolveSourceMessageFolder({
    database: db,
    drive: dependencies.attachments,
    accessToken,
    subject: subjectOf(message.payload),
    receivedAt: receivedAtOf(message.internalDate) ?? new Date().toISOString(),
    recordedFolderId: known?.driveFolderId,
    ...(known?.id === undefined ? {} : { sourceMessageId: known.id }),
  });
  for (const attachment of contents) {
    const publication = await dependencies.attachments.publish({ accessToken, attachment, parentFolderId: folderId });
    if (publication.outcome === 'failed' || !publication.publicUrl) {
      throw new Error(`添付ファイル ${attachment.filename} を公開できませんでした。`);
    }
    resolved.links.push({ filename: attachment.filename, url: publication.publicUrl });
    resolved.calendar.push({ fileUrl: publication.publicUrl, title: attachment.filename, mimeType: attachment.mimeType });
  }
  return resolved;
};

const desiredCalendarFields = (
  candidate: EventDetails,
  messageId: string,
  links: AttachmentLink[],
): DesiredCalendarFields => ({
  title: candidate.title,
  description: calendarEventDescription({
    summary: candidate.summary,
    attachments: links,
    attribution: sourceMessageAttribution(messageId),
  }),
  location: candidate.location,
  startsAt: candidate.startsAt,
  endsAt: candidate.endsAt,
  timeZone: candidate.timeZone,
});

export interface MailboxTestRefreshRequest {
  existing: CalendarEventFields[];
  outOfWindow: CalendarEventFields[];
  request: AiEventCorrespondenceRequest | null;
}

/** Prepares the correspondence request for review without calling the AI API. */
const previewEventRefreshRequestWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; events: EventDetails[] },
  dependencies: AutomationDependencies,
): Promise<MailboxTestRefreshRequest> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const found = await attributedScheduledEvents(dependencies, accessToken, input.messageId, input.events);
  const { inWindow, outOfWindow } = partitionByRefreshWindow(input.events, found);
  return {
    existing: inWindow,
    outOfWindow,
    request: inWindow.length ? buildEventCorrespondenceRequest({ candidates: input.events, existing: inWindow }) : null,
  };
};

export interface MailboxTestRefreshPlan extends RefreshPlan {
  desired: DesiredCalendarFields[];
  pendingAttachments: string[];
}

/** Asks the AI for a correspondence and turns it into the plan an Admin approves. */
const planEventRefreshWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; events: EventDetails[] },
  dependencies: AutomationDependencies,
): Promise<MailboxTestRefreshPlan> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const message = await mailboxMessage(dependencies.google, accessToken, input.messageId);
  const found = await attributedScheduledEvents(dependencies, accessToken, input.messageId, input.events);
  const { inWindow, outOfWindow } = partitionByRefreshWindow(input.events, found);
  const attachments = await resolveRefreshAttachments(dependencies, accessToken, database, message, input.messageId, false);
  const desired = input.events.map((candidate) => desiredCalendarFields(candidate, input.messageId, attachments.links));
  const correspondences = inWindow.length
    ? await aiEventCorrespondence(env, organizationId, database, input.events, inWindow, dependencies)
    : [];
  const plan = refreshPlan({ candidates: input.events, existing: [...inWindow, ...outOfWindow], correspondences, desired });
  return { ...plan, desired, pendingAttachments: attachments.pending };
};

const aiEventCorrespondence = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  candidates: EventDetails[],
  existing: CalendarEventFields[],
  dependencies: AutomationDependencies,
): Promise<EventCorrespondence[]> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new Error('先に OpenAI 互換 API を設定してください。');
  const key = await organizationKeyFor(env, organizationId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as AiCredential;
  if (!credential.apiKey || !credential.model) throw new Error('先に OpenAI 互換 API を設定してください。');
  const correspondences = await dependencies.ai.correspond({
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL,
    model: credential.model,
    candidates,
    existing,
  });
  if (!correspondences) throw new Error('AI が既存予定との対応を判定できませんでした。');
  return correspondences;
};

export interface EventRefreshEntry {
  googleEventId: string | null;
  etag: string | null;
  candidate: EventDetails;
}

export interface EventRefreshConflict {
  googleEventId: string;
  etag: string | null;
  current: CalendarEventFields;
  changedFields: string[];
  candidate: EventDetails;
}

export interface EventRefreshOutcome {
  updated: string[];
  created: string[];
  conflicts: EventRefreshConflict[];
  failures: Array<{ googleEventId: string | null; title: string; message: string }>;
}

const recordRefreshEffect = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { googleEventId: string; candidate: EventDetails; messageId: string; effect: 'updated' | 'created' },
): Promise<void> => {
  const timestamp = now();
  if (input.effect === 'updated') {
    await drizzleOrganizationDatabase(database).update(events).set({
      title: input.candidate.title,
      startsAt: input.candidate.startsAt,
      endsAt: input.candidate.endsAt,
      location: input.candidate.location,
      description: input.candidate.description,
      updatedAt: timestamp,
    }).where(eq(events.googleEventId, input.googleEventId)).run();
  }
  await recordDeliveryAttempt(database, {
    destination: 'primary',
    channel: 'calendar',
    outcome: 'succeeded',
    externalId: input.googleEventId,
  });
  await writeRecoveryReceipt({
    bucket: env.RECOVERY_RECEIPTS,
    organizationKey: await organizationKeyFor(env, organizationId),
    receipt: {
      organizationId,
      idempotencyKey: `event-refresh:${input.googleEventId}:${timestamp}`,
      effectType: 'calendar',
      externalId: input.googleEventId,
      destinationFingerprint: `mail-test:${input.messageId}`,
      succeededAt: timestamp,
    },
  });
};

/**
 * The Event Refresh exit: rewrites every Calendar field of an already confirmed
 * Scheduled Event, deliberately overwriting Manual Overrides because an Admin
 * approved this one event's diff, and additively invites the active Member
 * roster. A Member the Calendar already lists — invited earlier by this same
 * exit or by ADR 0125's automated invitation — keeps whatever they answered;
 * only Members missing from that list are appended.
 */
const applyEventRefreshWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; entries: EventRefreshEntry[] },
  dependencies: AutomationDependencies,
): Promise<EventRefreshOutcome> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database), dependencies);
  const message = await mailboxMessage(dependencies.google, accessToken, input.messageId);
  const attachments = await resolveRefreshAttachments(dependencies, accessToken, database, message, input.messageId, true);
  const invitees = await activeMemberInvitees(database);
  const outcome: EventRefreshOutcome = { updated: [], created: [], conflicts: [], failures: [] };
  for (const entry of input.entries) {
    const desired = desiredCalendarFields(entry.candidate, input.messageId, attachments.links);
    const fields = {
      summary: desired.title,
      description: desired.description,
      location: desired.location,
      start: { dateTime: desired.startsAt, timeZone: desired.timeZone },
      end: { dateTime: desired.endsAt, timeZone: desired.timeZone },
      attachments: attachments.calendar,
    };
    try {
      if (!entry.googleEventId) {
        const attendees = invitees.map(({ email }) => ({ email }));
        const url = new URL(CALENDAR_EVENTS_URL);
        url.searchParams.set('sendUpdates', attendees.length ? 'all' : 'none');
        if (attachments.calendar.length) url.searchParams.set('supportsAttachments', 'true');
        const created = await dependencies.google.request<CalendarEventResource>(accessToken, url.toString(), {
          method: 'POST',
          body: JSON.stringify({ ...fields, attendees }),
        });
        if (!created.id) throw new Error('Google Calendar が予定 ID を返しませんでした。');
        outcome.created.push(created.id);
        await recordRefreshEffect(env, organizationId, database, {
          googleEventId: created.id, candidate: entry.candidate, messageId: input.messageId, effect: 'created',
        });
        continue;
      }
      const existing = await dependencies.google.request<CalendarEventResource>(
        accessToken,
        `${CALENDAR_EVENTS_URL}/${encodeURIComponent(entry.googleEventId)}`,
      );
      const { attendees, added } = invitedAttendees(existing.attendees ?? [], invitees);
      const url = new URL(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(entry.googleEventId)}`);
      url.searchParams.set('sendUpdates', added ? 'all' : 'none');
      if (attachments.calendar.length) url.searchParams.set('supportsAttachments', 'true');
      await dependencies.google.request<CalendarEventResource>(accessToken, url.toString(), {
        method: 'PATCH',
        body: JSON.stringify({ ...fields, attendees }),
        ...(entry.etag ? { headers: { 'If-Match': entry.etag } } : {}),
      });
      outcome.updated.push(entry.googleEventId);
      await recordRefreshEffect(env, organizationId, database, {
        googleEventId: entry.googleEventId, candidate: entry.candidate, messageId: input.messageId, effect: 'updated',
      });
    } catch (error) {
      const conflicted = error instanceof GoogleApiError && (error.status === 412 || error.status === 409);
      if (!conflicted || !entry.googleEventId) {
        outcome.failures.push({
          googleEventId: entry.googleEventId,
          title: entry.candidate.title,
          message: error instanceof Error ? error.message : 'Google Calendar の更新に失敗しました。',
        });
        continue;
      }
      const current = calendarEventFields(await dependencies.google.request<CalendarEventResource>(
        accessToken,
        `${CALENDAR_EVENTS_URL}/${encodeURIComponent(entry.googleEventId)}`,
      ));
      if (!current) {
        outcome.failures.push({
          googleEventId: entry.googleEventId,
          title: entry.candidate.title,
          message: '照合後に変更された予定を読み直せませんでした。',
        });
        continue;
      }
      outcome.conflicts.push({
        googleEventId: entry.googleEventId,
        etag: current.etag,
        current,
        changedFields: changedCalendarFields(current, desired),
        candidate: entry.candidate,
      });
    }
  }
  return outcome;
};

const processOrganizationMessage = async (
  dependencies: AutomationDependencies,
  env: Bindings,
  database: D1Database,
  organizationId: string,
  accessToken: string,
  gmailHistoryId: string,
  gmailMessageId: string,
  reprocessSkipped = false,
): Promise<void> => {
  const db = drizzleOrganizationDatabase(database);
  const known = await db.select({ id: sourceMessages.id, state: sourceMessages.state, driveFolderId: sourceMessages.driveFolderId }).from(sourceMessages)
    .where(eq(sourceMessages.gmailMessageId, gmailMessageId)).get();
  if (known && !(reprocessSkipped && known.state === 'skipped')) return;
  const message = await dependencies.google.request<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`);
  // Gmail history reports messages added to Sent as well as received mail. An
  // outbound reply is not a Source Message and must be rejected before any D1,
  // AI, Calendar, Drive, or recipient-delivery side effect can occur.
  if (message.labelIds?.includes('SENT')) return;
  const subject = subjectOf(message.payload);
  const sourceMessageId = known?.id ?? crypto.randomUUID();
  const timestamp = now();
  if (known) {
    await db.update(sourceMessages).set({
      gmailHistoryId,
      sender: senderOf(message.payload),
      subject,
      processedAt: timestamp,
      state: 'processing',
    }).where(eq(sourceMessages.id, sourceMessageId)).run();
  } else {
    await db.insert(sourceMessages).values({
      id: sourceMessageId,
      gmailMessageId,
      gmailHistoryId,
      sender: senderOf(message.payload),
      subject,
      receivedAt: timestamp,
      processedAt: timestamp,
      state: 'processing',
    }).run();
  }
  const body = decodedBody(message.payload) || (message.snippet ?? '');
  const [activeRules, activeAgentRuleRows] = await Promise.all([
    db.select({
      id: automationRules.id,
      priority: automationRules.priority,
      selectionPolicy: automationRules.selectionPolicy,
      taskRoleIds: automationRules.taskRoleIds,
    }).from(automationRules).where(eq(automationRules.status, 'active')).orderBy(automationRules.priority).all(),
    db.select({ id: agentRules.id, priority: agentRules.priority, promptId: agentRules.promptId, revision: agentRules.currentRevision, selectionPolicy: agentRules.selectionPolicy, executionMode: agentRules.executionMode })
      .from(agentRules).where(eq(agentRules.status, 'active')).orderBy(agentRules.priority).all(),
  ]);
  const activeRuleIds = activeRules.map(({ id }) => id);
  const [permittedRecipientLists, permittedLineLists] = activeRuleIds.length ? await Promise.all([
    db.select().from(rulePermittedRecipientLists)
      .where(inArray(rulePermittedRecipientLists.ruleId, activeRuleIds)).all(),
    db.select().from(rulePermittedLineLists)
      .where(inArray(rulePermittedLineLists.ruleId, activeRuleIds)).all(),
  ]) : [[], []];
  const activeAgentRuleIds = activeAgentRuleRows.map(({ id }) => id);
  const [agentRecipientLists, agentLineLists] = activeAgentRuleIds.length ? await Promise.all([
    db.select().from(agentRulePermittedRecipientLists).where(inArray(agentRulePermittedRecipientLists.agentRuleId, activeAgentRuleIds)).all(),
    db.select().from(agentRulePermittedLineLists).where(inArray(agentRulePermittedLineLists.agentRuleId, activeAgentRuleIds)).all(),
  ]) : [[], []];
  const source = { sender: senderOf(message.payload), subject, body, ...(message.labelIds === undefined ? {} : { labels: message.labelIds }) };
  const rule = selectActiveRule(activeRules.flatMap((row) => {
    try { return [{
      id: row.id,
      priority: row.priority,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      taskRoleIds: JSON.parse(row.taskRoleIds) as string[],
      permittedRecipientListIds: permittedRecipientLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      permittedLineListIds: permittedLineLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
    }]; }
    catch { return []; }
  }), source);
  const matchingAgentRules = activeAgentRuleRows.flatMap((row): ActiveAgentRule[] => {
    try {
      const candidate = {
        id: row.id, priority: row.priority, promptId: row.promptId, revision: row.revision,
        selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>, executionMode: row.executionMode,
        permittedRecipientListIds: agentRecipientLists.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
        permittedLineListIds: agentLineLists.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
      };
      return ruleMatches(candidate, source) ? [candidate] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => right.priority - left.priority);
  if (!rule && !matchingAgentRules.length) {
    await db.update(sourceMessages).set({ state: 'skipped', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const attachmentIntake = validateAttachmentIntake(sourceAttachmentSizes(message.payload));
  if (!attachmentIntake.accepted) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: attachmentIntake.reason,
      message: 'Source Message attachments exceed the configured intake limit.',
      state: 'open',
      createdAt: now(),
    }).run();
    if (rule) await deliverSourceMessageNotice({
      dependencies,
      env,
      database,
      organizationId,
      googleAccessToken: accessToken,
      sourceMessageId,
      rule,
      subject: `Intake Notice: ${subject}`,
      body: `差出人: ${senderOf(message.payload)}\r\n件名: ${subject}`,
    });
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const attachments = sourceAttachments(message.payload);
  let attachmentContents: SourceAttachmentContent[];
  try {
    attachmentContents = await dependencies.attachments.read({
      accessToken,
      gmailMessageId,
      attachments,
    });
  } catch (error) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'gmail_attachment_download_failed',
      message: error instanceof Error ? error.message : 'Gmail attachment download failed.',
      state: 'open',
      createdAt: now(),
    }).run();
    if (rule) await deliverSourceMessageNotice({
      dependencies,
      env,
      database,
      organizationId,
      googleAccessToken: accessToken,
      sourceMessageId,
      rule,
      subject: `Intake Notice: ${subject}`,
      body: `差出人: ${senderOf(message.payload)}\r\n件名: ${subject}`,
    });
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  let sharedConvertedAttachments: ConvertedAttachment[] | undefined;
  try {
    sharedConvertedAttachments = matchingAgentRules.length
      ? await convertAttachmentsForEventExtraction(attachmentContents, env.AI)
      : undefined;
  } catch (error) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'source_attachment_conversion_failed',
      message: error instanceof Error ? error.message : 'Source Message attachment conversion failed.',
      state: 'open',
      createdAt: now(),
    }).run();
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const agentFailed = await runMatchingAgentRules({
    dependencies,
    env,
    database,
    organizationId,
    sourceMessageId,
    sender: source.sender,
    subject,
    body,
    attachments: sharedConvertedAttachments ?? [],
    googleAccessToken: accessToken,
    rules: matchingAgentRules,
  });
  if (!rule) {
    await db.update(sourceMessages).set({ state: agentFailed ? 'exception' : 'processed', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const organizationRoles = await db.select({
    id: operationalTaskRoles.id,
    displayName: operationalTaskRoles.displayName,
    description: operationalTaskRoles.description,
  }).from(operationalTaskRoles).all();
  const allowedRoleIds = new Set(rule.taskRoleIds ?? []);
  const allowedTaskRoles = organizationRoles.filter((role) => allowedRoleIds.has(role.id));
  const extraction = await aiExtraction(env, organizationId, database, `${subject}\n${body}`, attachmentContents, sharedConvertedAttachments, allowedTaskRoles, receivedAtOf(message.internalDate), dependencies);
  if (extraction === undefined) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'ai_connection_missing',
      message: 'An active AI Connection is required to analyze incoming mail.',
      state: 'open',
      createdAt: now(),
    }).run();
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  if (extraction === null) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'ai_event_details_invalid',
      message: 'The AI API could not produce safe Event Details.',
      state: 'open',
      createdAt: now(),
    }).run();
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  if (extraction?.warnings.length) {
    await db.insert(automationWarnings).values(extraction.warnings.map((warning) => ({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: warning.code,
      message: warning.message,
      createdAt: now(),
    }))).run();
  }
  if (extraction) await deliverSourceMessageNotice({
    dependencies,
    env,
    database,
    organizationId,
    googleAccessToken: accessToken,
    sourceMessageId,
    rule,
    subject: `Message Summary: ${subject}`,
    body: extraction.summary,
  });
  const candidates = extraction.events;
  if (extraction.tasks.length) {
    await createTaskWorkflow(db).createFromSourceMessage({
      organizationId,
      sourceMessageId,
      sourceMessageSubject: subject,
      extractedTasks: extraction.tasks,
    });
  }
  if (!candidates.length) {
    await db.update(sourceMessages).set({ state: agentFailed ? 'exception' : 'processed', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  let attachmentFolderId: string | null = null;
  if (attachmentContents.length) {
    try {
      attachmentFolderId = await resolveSourceMessageFolder({
        database: db,
        drive: dependencies.attachments,
        accessToken,
        subject,
        receivedAt: receivedAtOf(message.internalDate) ?? timestamp,
        recordedFolderId: known?.driveFolderId,
        sourceMessageId,
      });
    } catch (error) {
      await db.insert(automationWarnings).values({
        id: crypto.randomUUID(),
        sourceMessageId,
        code: 'attachment_folder_unavailable',
        message: error instanceof Error ? error.message : 'The Attachment Folder Path could not be created in Drive.',
        createdAt: now(),
      }).run();
    }
  }
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: attachmentFolderId
      ? await dependencies.attachments.publish({ accessToken, attachment, parentFolderId: attachmentFolderId })
      : unpublishedAttachment,
  })));
  const publicationFailed = publications.some(({ publication }) => publication.outcome === 'failed');
  const attachmentLinks = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ filename: attachment.filename, url: publication.publicUrl }]
    : []);
  const calendarAttachments = publications.flatMap(({ attachment, publication }) => publication.publicUrl ? [{
    fileUrl: publication.publicUrl,
    title: attachment.filename,
    mimeType: attachment.mimeType,
  }] : []);
  const invitees = await activeMemberInvitees(database);
  /** An unpublished attachment keeps the event an administrative draft, so its Members are not invited yet. */
  const attendees = publicationFailed ? [] : invitees;
  const calendarUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  if (calendarAttachments.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  if (attendees.length) calendarUrl.searchParams.set('sendUpdates', 'all');
  for (const candidate of candidates) {
    const event = await dependencies.google.request<CalendarEvent>(accessToken, calendarUrl.toString(), {
      method: 'POST',
      body: JSON.stringify({
        summary: candidate.title,
        description: calendarEventDescription({
          summary: candidate.summary,
          attachments: attachmentLinks,
          attribution: `Mail Automation が Gmail メッセージ ${gmailMessageId} から作成しました。`,
        }),
        start: { dateTime: candidate.startsAt, timeZone: 'Asia/Tokyo' },
        end: { dateTime: candidate.endsAt, timeZone: 'Asia/Tokyo' },
        attachments: calendarAttachments,
        attendees: attendees.map(({ email }) => ({ email })),
      }),
    });
    if (!event.id) throw new Error('Google Calendar did not return an event ID.');
    const eventId = crypto.randomUUID();
    const eventCreatedAt = now();
    await db.insert(events).values({
      id: eventId,
      organizationId,
      ruleId: rule.id,
      sourceMessageId,
      googleEventId: event.id,
      title: candidate.title,
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
      status: publicationFailed ? 'draft' : 'scheduled',
      createdAt: eventCreatedAt,
      updatedAt: eventCreatedAt,
    }).run();
    await recordEventInvitations({
      database,
      eventId,
      googleEventId: event.id,
      invitees,
      outcome: publicationFailed ? 'pending' : 'succeeded',
    });
    for (const { attachment, publication } of publications) {
      await db.insert(eventAttachments).values({
        id: crypto.randomUUID(),
        eventId,
        gmailAttachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.size,
        driveFileId: publication.driveFileId,
        publicUrl: publication.publicUrl,
        outcome: publication.outcome,
        createdAt: now(),
      }).run();
      await db.insert(deliveries).values({
        id: crypto.randomUUID(),
        eventId,
        channel: 'drive',
        destination: attachment.filename,
        outcome: publication.outcome,
        externalId: publication.driveFileId,
        createdAt: now(),
      }).run();
    }
  }
  if (publicationFailed) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'drive_attachment_publish_failed',
      message: '一部の添付ファイルを公開できませんでした。',
      state: 'open',
      createdAt: now(),
    }).run();
  }
  await db.update(sourceMessages).set({
    state: publicationFailed || agentFailed ? 'exception' : 'processed',
    processedAt: now(),
  }).where(eq(sourceMessages.id, sourceMessageId)).run();
};

const runOrganizationInbox = async (
  dependencies: AutomationDependencies,
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
  reprocessSkipped = false,
): Promise<{ reprocessed: number }> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, inbox, dependencies);
  const db = drizzleOrganizationDatabase(database);
  let reprocessed = 0;
  if (reprocessSkipped) {
    const skippedMessages = await db.select({
      id: sourceMessages.id,
      gmailMessageId: sourceMessages.gmailMessageId,
      gmailHistoryId: sourceMessages.gmailHistoryId,
    }).from(sourceMessages).where(eq(sourceMessages.state, 'skipped')).all();
    for (const skipped of skippedMessages) {
      try {
        await processOrganizationMessage(
          dependencies,
          env,
          database,
          organizationId,
          accessToken,
          skipped.gmailHistoryId,
          skipped.gmailMessageId,
          true,
        );
      } catch (error) {
        if (!(error instanceof GoogleApiError)
          || error.status !== 404
          || !error.url.includes(`/messages/${encodeURIComponent(skipped.gmailMessageId)}`)) throw error;
        await db.update(sourceMessages).set({ state: 'processed', processedAt: now() })
          .where(eq(sourceMessages.id, skipped.id)).run();
      }
      reprocessed += 1;
    }
  }
  let pageToken: string | undefined;
  let historyId = inbox.gmailHistoryId;
  do {
    const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    query.searchParams.set('startHistoryId', inbox.gmailHistoryId);
    query.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) query.searchParams.set('pageToken', pageToken);
    const history = await dependencies.google.request<GmailHistory>(accessToken, query.toString());
    for (const entry of history.history ?? []) {
      for (const message of entry.messagesAdded ?? []) {
        const messageId = message.message?.id;
        if (!messageId) continue;
        try {
          await processOrganizationMessage(dependencies, env, database, organizationId, accessToken, inbox.gmailHistoryId, messageId);
        } catch (error) {
          if (error instanceof GoogleApiError && error.status === 404 && error.url.includes(`/messages/${encodeURIComponent(messageId)}`)) continue;
          throw error;
        }
      }
    }
    historyId = history.historyId ?? historyId;
    pageToken = history.nextPageToken;
  } while (pageToken);
  const syncedAt = now();
  await db.update(googleConnections)
    .set({
      gmailHistoryId: historyId,
      lastSyncedAt: syncedAt,
      lastError: null,
      failingSince: null,
      alertedAt: null,
      updatedAt: syncedAt,
    })
    .where(eq(googleConnections.id, inbox.id))
    .run();
  return { reprocessed };
};

const automationCounts = async (database: D1Database): Promise<{ scanned: number; created: number; skipped: number; exceptions: number }> => {
  const db = drizzleOrganizationDatabase(database);
  const [scanned, created, skipped, exceptions] = await Promise.all([
    db.select({ value: count() }).from(sourceMessages).get(),
    db.select({ value: count() }).from(events).where(eq(events.status, 'scheduled')).get(),
    db.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'skipped')).get(),
    db.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'exception')).get(),
  ]);
  return {
    scanned: scanned?.value ?? 0,
    created: created?.value ?? 0,
    skipped: skipped?.value ?? 0,
    exceptions: exceptions?.value ?? 0,
  };
};

const runOrganizationAutomationWithGoogle = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  dependencies: AutomationDependencies,
): Promise<AutomationSummary> => {
  const db = drizzleOrganizationDatabase(database);
  const inbox = await db.select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
    eq(googleConnections.enabled, true),
  )).limit(1).get();
  if (!inbox) throw new Error('有効な Automation Inbox が見つかりません。');
  await requireActiveAiConnection(database);
  const baseline = await ensureBaselineSchemaRule(db, organizationId);
  await expireProposedActions(database);
  const before = await automationCounts(database);
  const run = await runOrganizationInbox(dependencies, env, organizationId, database, inbox, baseline.repairSkipped);
  await completeBaselineSkippedRepair(db);
  const after = await automationCounts(database);
  return {
    scanned: after.scanned - before.scanned + run.reprocessed,
    created: after.created - before.created,
    skipped: Math.max(0, after.skipped - before.skipped),
    exceptions: after.exceptions - before.exceptions,
  };
};

const runEnabledAutomationsWithDependencies = async (env: Bindings, dependencies: AutomationDependencies): Promise<void> => {
  const activeOrganizations = await drizzleControlDatabase(env.CONTROL_DB).select({
    id: organizations.id,
    bindingName: organizations.bindingName,
    databaseId: organizations.databaseId,
  }).from(organizations).where(and(
    eq(organizations.status, 'active'),
    isNotNull(organizations.databaseId),
  )).orderBy(organizations.updatedAt).limit(20).all();
  const databases = createDatabaseAccess(env);
  for (const organization of activeOrganizations) {
    // One Organization whose database or schema is unreachable must not end the
    // scheduled sweep before the Organizations after it have run.
    try {
      const database = await databases.open({
        kind: 'organization',
        bindingName: organization.bindingName,
        databaseId: organization.databaseId,
      });
      const orgDb = drizzleOrganizationDatabase(database.raw);
      await expireProposedActions(database.raw);
      const inboxes = await orgDb.select().from(googleConnections).where(and(
        eq(googleConnections.kind, 'automation_inbox'),
        eq(googleConnections.status, 'active'),
        eq(googleConnections.enabled, true),
      )).all();
      for (const inbox of inboxes) {
        try {
          await requireActiveAiConnection(database.raw);
          const baseline = await ensureBaselineSchemaRule(orgDb, organization.id);
          await runOrganizationInbox(dependencies, env, organization.id, database.raw, inbox, baseline.repairSkipped);
          await completeBaselineSkippedRepair(orgDb);
        } catch (error) {
          await recordAutomationFailure({
            env,
            organizationId: organization.id,
            database: database.raw,
            inbox,
            error,
            dependencies,
          });
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'automation_organization_skipped',
        organizationId: organization.id,
        message: error instanceof Error ? error.message : 'Organization automation could not start.',
      }));
    }
  }
};

/**
 * The Organization Automation module's interface. HTTP and scheduled callers
 * know only the use-cases; provider transport remains an implementation detail.
 */
export const createAutomation = (
  env: Bindings,
  overrides: Partial<AutomationDependencies> = {},
) => {
  const dependencies: AutomationDependencies = { ...productionDependencies, ...overrides };
  return {
    runOrganization: (input: { organizationId: string; database: D1Database }): Promise<AutomationSummary> =>
      runOrganizationAutomationWithGoogle(env, input.organizationId, input.database, dependencies),
    verifyOrganizationInboxCredential: (input: { organizationId: string; database: D1Database }): Promise<void> =>
      verifyOrganizationInboxCredentialWithDependencies(env, input.organizationId, input.database, dependencies),
    runEnabledOrganizations: (): Promise<void> => runEnabledAutomationsWithDependencies(env, dependencies),
    mailboxTest: {
      search: (input: { organizationId: string; database: D1Database; subject: string }): Promise<MailboxTestMatch[]> =>
        searchMailboxForTestWithGoogle(env, input.organizationId, input.database, input.subject, dependencies),
      readSource: (input: { organizationId: string; database: D1Database; messageId: string }): Promise<MailboxTestSource> =>
        readMailboxTestSourceWithGoogle(env, input.organizationId, input.database, input.messageId, dependencies),
      createCalendarEvents: (input: { organizationId: string; database: D1Database; messageId: string; events: EventDetails[] }): Promise<{ eventIds: string[] }> =>
        createMailboxTestCalendarEventsWithGoogle(env, input.organizationId, input.database, { messageId: input.messageId, events: input.events }, dependencies),
      extractPackage: (input: { organizationId: string; database: D1Database; source: string; attachments: SourceAttachmentContent[]; receivedAt?: string }): Promise<MailExtraction | null> =>
        extractMailboxTestPackage(env, input.organizationId, input.database, input.source, input.attachments, input.receivedAt, dependencies),
      previewAiRequest: (input: { database: D1Database; source: string; attachments: SourceAttachmentContent[]; receivedAt?: string }): Promise<AiEventDetailsRequest> =>
        previewMailboxTestAiRequest(env, input),
      previewRefreshRequest: (input: { organizationId: string; database: D1Database; messageId: string; events: EventDetails[] }): Promise<MailboxTestRefreshRequest> =>
        previewEventRefreshRequestWithGoogle(env, input.organizationId, input.database, { messageId: input.messageId, events: input.events }, dependencies),
      planRefresh: (input: { organizationId: string; database: D1Database; messageId: string; events: EventDetails[] }): Promise<MailboxTestRefreshPlan> =>
        planEventRefreshWithGoogle(env, input.organizationId, input.database, { messageId: input.messageId, events: input.events }, dependencies),
      applyRefresh: (input: { organizationId: string; database: D1Database; messageId: string; entries: EventRefreshEntry[] }): Promise<EventRefreshOutcome> =>
        applyEventRefreshWithGoogle(env, input.organizationId, input.database, { messageId: input.messageId, entries: input.entries }, dependencies),
    },
  };
};

/** @deprecated Prefer the Automation module interface at call sites. */
export const runOrganizationAutomation = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
): Promise<AutomationSummary> => createAutomation(env).runOrganization({ organizationId, database });

/** @deprecated Prefer the Automation module interface at call sites. */
export const runEnabledAutomations = async (env: Bindings): Promise<void> => createAutomation(env).runEnabledOrganizations();
