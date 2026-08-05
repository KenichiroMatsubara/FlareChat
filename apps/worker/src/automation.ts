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
  withinRefreshWindow,
} from './event-refresh';
import type {
  AiEventCorrespondenceRequest,
  CalendarAttendee,
  CalendarEventFields,
  DesiredCalendarFields,
  EventCorrespondence,
  RefreshPlan,
} from './event-refresh';
import {
  lockedCalendarFields,
  mergedCalendarFields,
  isSignificantChange,
  organizationResponseWindowDays,
  responseSearchWindow,
  withinResponseWindow,
} from './event-merge';
import type { RecordedEventFields } from './event-merge';
import { guestCountsLine } from './guests';
import { canApplyCalendarUpdate } from './calendar-revisions';
import { writeRecoveryReceipt } from './recovery-receipts';
import { resolveSourceMessageFolder } from './attachment-folders';
import { createTaskWorkflow } from './tasks';
import { createRuleExecution, type ExecutionMode, type RuleEffectPort } from './execution';
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
import { AGENT_TRANSCRIPT_RETENTION_DAYS, AgentRunFailure, runAgent, writeAgentRunTranscript } from './agent-runs';
import type { AgentWritePort } from './agent-runs';
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
  guestRegistrations,
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
  revision: number;
  priority: number;
  executionMode: ExecutionMode;
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
  executionMode: ExecutionMode;
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
      const execution = createRuleExecution({
        database: input.database,
        planner: { plan: async () => [{
          rule: { type: 'agent', id: rule.id, revision: rule.revision },
          executionMode: rule.executionMode,
          effects: runResult!.plannedActions.map((action, index) => ({
            key: `${action.tool}:${index}`,
            kind: `agent.${action.tool}`,
            arguments: action.arguments,
            dependsOn: [],
          })),
        }] },
        effects: { apply: async ({ effect }) => effect.kind === 'agent.send_line_message'
          ? writes.sendLine(effect.arguments as { destination: string; message: string })
          : writes.createScheduledEvent(effect.arguments as { destination: string; title: string; startsAt: string; endsAt: string; location?: string; description?: string }) },
        id: (() => {
          let runIdAvailable = true;
          return () => {
            if (!runIdAvailable) return crypto.randomUUID();
            runIdAvailable = false;
            return runId;
          };
        })(),
      });
      await execution.start({ sourceMessageId: input.sourceMessageId, intent: { kind: 'live' } });
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
  allowedTaskRoleIds?: ReadonlySet<string>,
): Promise<MailExtraction | null> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new Error('先に OpenAI 互換 API を設定してください。');
  const key = await organizationKeyFor(env, organizationId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as AiCredential;
  if (!credential.apiKey || !credential.model) throw new Error('先に OpenAI 互換 API を設定してください。');
  const taskRoles = (await drizzleOrganizationDatabase(database).select({
    id: operationalTaskRoles.id,
    displayName: operationalTaskRoles.displayName,
    description: operationalTaskRoles.description,
  }).from(operationalTaskRoles).all()).filter((role) => !allowedTaskRoleIds || allowedTaskRoleIds.has(role.id));
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

/** Evaluates a Draft Schema Rule before making the Mailbox Test's AI request. */
export const previewSchemaDraftRule = async (input: {
  env: Bindings;
  database: D1Database;
  organizationId: string;
  ruleId: string;
  messageId: string;
}): Promise<{ source: MailboxTestSource; extraction: MailExtraction }> => {
  const db = drizzleOrganizationDatabase(input.database);
  const rule = await db.select().from(automationRules).where(eq(automationRules.id, input.ruleId)).get();
  if (!rule || rule.status !== 'draft') throw new Error('Mailbox Test requires a Draft Schema Rule.');
  const source = await readMailboxTestSourceWithGoogle(
    input.env, input.organizationId, input.database, input.messageId, productionDependencies,
  );
  if (!ruleMatches({ selectionPolicy: JSON.parse(rule.selectionPolicy) as Record<string, unknown> }, {
    sender: source.sender, subject: source.subject, body: source.source,
  })) {
    throw new Error('The selected Source Message does not match this Rule Selection Policy.');
  }
  const extraction = await extractMailboxTestPackage(
    input.env, input.organizationId, input.database, source.source, source.attachments,
    source.receivedAt, productionDependencies, new Set(JSON.parse(rule.taskRoleIds) as string[]),
  );
  if (!extraction) throw new Error('メールから安全な予定を抽出できませんでした。日付・開始時刻・終了時刻を確認してください。');
  return { source, extraction };
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

/** One Scheduled Event a candidate may be merged into, as Calendar holds it and as D1 recorded it. */
interface CorrelationTarget {
  rowId: string;
  googleEventId: string;
  current: CalendarEventFields;
  recorded: RecordedEventFields;
  /** The Calendar Revision recorded at the last write, held as the optimistic lock. */
  storedEtag: string | null;
}

/**
 * The Scheduled Events this Organization's automation owns inside a time window,
 * each paired with the values Mail Automation last wrote. Calendar supplies the
 * window and the live state; D1 supplies what a merge is allowed to overwrite.
 */
const correlationTargets = async (
  dependencies: AutomationDependencies,
  accessToken: string,
  database: D1Database,
  window: { timeMin: string; timeMax: string },
): Promise<CorrelationTarget[]> => {
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set('timeMin', window.timeMin);
  url.searchParams.set('timeMax', window.timeMax);
  url.searchParams.set('showDeleted', 'false');
  url.searchParams.set('singleEvents', 'false');
  url.searchParams.set('maxResults', '250');
  const list = await dependencies.google.request<CalendarEventList>(accessToken, url.toString());
  const attributed = (list.items ?? []).flatMap((item) => {
    const fields = calendarEventFields(item);
    return fields && attributedMessageId(fields.description) !== null ? [fields] : [];
  });
  if (!attributed.length) return [];
  const rows = await drizzleOrganizationDatabase(database).select({
    id: events.id,
    googleEventId: events.googleEventId,
    title: events.title,
    calendarDescription: events.calendarDescription,
    calendarEtag: events.calendarEtag,
    location: events.location,
    startsAt: events.startsAt,
    endsAt: events.endsAt,
  }).from(events).where(inArray(events.googleEventId, attributed.map((event) => event.id))).all();
  const recorded = new Map(rows.flatMap((row) => row.googleEventId ? [[row.googleEventId, row] as const] : []));
  return attributed.flatMap((current) => {
    const row = recorded.get(current.id);
    return row ? [{
      rowId: row.id,
      googleEventId: current.id,
      current,
      storedEtag: row.calendarEtag,
      recorded: {
        title: row.title,
        description: row.calendarDescription,
        location: row.location,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
    }] : [];
  });
};

/** The Guest Registration line for a Scheduled Event, or undefined when nobody outside has registered. */
const guestCountsFor = async (database: D1Database, eventId: string): Promise<string | undefined> => {
  const rows = await drizzleOrganizationDatabase(database).select({
    name: guestRegistrations.name,
    affiliation: guestRegistrations.affiliation,
    attending: guestRegistrations.attending,
  }).from(guestRegistrations).where(eq(guestRegistrations.eventId, eventId)).all();
  return guestCountsLine(rows) ?? undefined;
};

/** The published attachments already linked from a Scheduled Event's description. */
const recordedAttachmentLinks = async (database: D1Database, eventId: string): Promise<AttachmentLink[]> => {
  const rows = await drizzleOrganizationDatabase(database).select({
    filename: eventAttachments.filename,
    publicUrl: eventAttachments.publicUrl,
  }).from(eventAttachments).where(eq(eventAttachments.eventId, eventId)).all();
  return rows.flatMap((row) => row.publicUrl ? [{ filename: row.filename, url: row.publicUrl }] : []);
};

/**
 * Asks which existing Scheduled Event each candidate belongs to and keeps only
 * the answers that fall inside the caller's window. The window is applied after
 * the AI has spoken, so a confident but distant match still cannot carry an
 * existing invitation list onto another meeting.
 */
const correlatedTargets = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  dependencies: AutomationDependencies,
  candidates: EventDetails[],
  targets: CorrelationTarget[],
  withinWindow: (candidateStartsAt: string, eventStartsAt: string) => boolean,
): Promise<Map<number, CorrelationTarget>> => {
  const matched = new Map<number, CorrelationTarget>();
  if (!targets.length) return matched;
  const correspondences = await aiEventCorrespondence(
    env, organizationId, database, candidates, targets.map((target) => target.current), dependencies,
  );
  for (const correspondence of correspondences) {
    if (correspondence.eventId === null) continue;
    const target = targets.find((value) => value.googleEventId === correspondence.eventId);
    const candidate = candidates[correspondence.candidateIndex];
    if (!target || !candidate || !withinWindow(candidate.startsAt, target.current.startsAt)) continue;
    matched.set(correspondence.candidateIndex, target);
  }
  return matched;
};

interface PlannedSchemaCorrelation {
  candidateIndex: number;
  target: CorrelationTarget;
}

/** Freezes every AI correspondence and Calendar revision before a Rule Run may wait for approval. */
const planSchemaCorrelations = async (input: {
  env: Bindings;
  organizationId: string;
  database: D1Database;
  dependencies: AutomationDependencies;
  accessToken: string;
  extraction: MailExtraction;
}): Promise<PlannedSchemaCorrelation[]> => {
  const candidates = input.extraction.events;
  if (!candidates.length) return [];
  const windowDays = input.extraction.kind === 'response'
    ? await organizationResponseWindowDays(drizzleOrganizationDatabase(input.database))
    : null;
  const window = input.extraction.kind === 'response'
    ? responseSearchWindow(candidates, windowDays!)
    : refreshSearchWindow(candidates);
  if (!window) return [];
  const targets = await correlationTargets(input.dependencies, input.accessToken, input.database, window);
  const matched = await correlatedTargets(
    input.env,
    input.organizationId,
    input.database,
    input.dependencies,
    candidates,
    targets,
    input.extraction.kind === 'response'
      ? (candidateStartsAt, eventStartsAt) => withinResponseWindow(candidateStartsAt, eventStartsAt, windowDays!)
      : withinRefreshWindow,
  );
  return [...matched].map(([candidateIndex, target]) => ({ candidateIndex, target }));
};

/** Keeps the first link for each published URL when a later message republishes a file. */
const distinctAttachmentLinks = (links: AttachmentLink[]): AttachmentLink[] => {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
};

const patchScheduledEvent = async (input: {
  dependencies: AutomationDependencies;
  accessToken: string;
  googleEventId: string;
  notify: boolean;
  body: Record<string, unknown>;
}): Promise<CalendarEventResource> => {
  const url = new URL(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(input.googleEventId)}`);
  url.searchParams.set('sendUpdates', input.notify ? 'all' : 'none');
  return input.dependencies.google.request<CalendarEventResource>(input.accessToken, url.toString(), {
    method: 'PATCH',
    body: JSON.stringify(input.body),
  });
};

/**
 * Merges one Event Candidate into the Scheduled Event it was correlated with.
 * The Calendar `attachments` list is deliberately left alone: a `PATCH` replaces
 * it wholesale, so writing this message's files would drop the chips an earlier
 * message put there. The description still links every published file.
 */
const mergeScheduledEvent = async (input: {
  dependencies: AutomationDependencies;
  database: D1Database;
  accessToken: string;
  target: CorrelationTarget;
  candidate: EventDetails;
  attachmentLinks: AttachmentLink[];
  gmailMessageId: string;
}): Promise<void> => {
  const guestCounts = await guestCountsFor(input.database, input.target.rowId);
  const description = calendarEventDescription({
    summary: input.candidate.summary,
    ...(guestCounts === undefined ? {} : { guestCounts }),
    attachments: distinctAttachmentLinks([
      ...await recordedAttachmentLinks(input.database, input.target.rowId),
      ...input.attachmentLinks,
    ]),
    attribution: sourceMessageAttribution(input.gmailMessageId),
  });
  const desired: DesiredCalendarFields = {
    title: input.candidate.title,
    description,
    location: input.candidate.location,
    startsAt: input.candidate.startsAt,
    endsAt: input.candidate.endsAt,
    timeZone: input.target.current.timeZone || 'Asia/Tokyo',
  };
  const lockedFields = lockedCalendarFields(input.target.current, input.target.recorded);
  const merged = mergedCalendarFields({ current: input.target.current, desired, locked: lockedFields });
  const changedFields = changedCalendarFields(input.target.current, merged);
  if (!canApplyCalendarUpdate({
    storedRevision: input.target.storedEtag,
    incomingRevision: input.target.current.etag,
    changedFields,
    lockedFields,
  })) return;
  const updated = await patchScheduledEvent({
    dependencies: input.dependencies,
    accessToken: input.accessToken,
    googleEventId: input.target.googleEventId,
    notify: isSignificantChange(changedFields),
    body: {
      summary: merged.title,
      description: merged.description,
      location: merged.location,
      start: { dateTime: merged.startsAt, timeZone: merged.timeZone },
      end: { dateTime: merged.endsAt, timeZone: merged.timeZone },
    },
  });
  await drizzleOrganizationDatabase(input.database).update(events).set({
    title: merged.title,
    startsAt: merged.startsAt,
    endsAt: merged.endsAt,
    location: merged.location,
    description: input.candidate.summary,
    calendarDescription: merged.description,
    calendarEtag: updated.etag ?? null,
    updatedAt: now(),
  }).where(eq(events.id, input.target.rowId)).run();
};

/**
 * Rewrites only the description of the Scheduled Event an Event Response
 * answered, so the Guest Registration counts it just changed are visible. A
 * guest moves neither the meeting nor its deadline, so this is never news to a
 * Member and never sends an update.
 */
const rewriteScheduledEventDescription = async (input: {
  dependencies: AutomationDependencies;
  database: D1Database;
  accessToken: string;
  target: CorrelationTarget;
  gmailMessageId: string;
}): Promise<void> => {
  const db = drizzleOrganizationDatabase(input.database);
  const row = await db.select({ summary: events.description }).from(events)
    .where(eq(events.id, input.target.rowId)).get();
  const guestCounts = await guestCountsFor(input.database, input.target.rowId);
  const description = calendarEventDescription({
    summary: row?.summary ?? '',
    ...(guestCounts === undefined ? {} : { guestCounts }),
    attachments: distinctAttachmentLinks(await recordedAttachmentLinks(input.database, input.target.rowId)),
    // The event keeps naming the message that described it, not the one answering it.
    attribution: sourceMessageAttribution(
      attributedMessageId(input.target.current.description) ?? input.gmailMessageId,
    ),
  });
  const lockedFields = lockedCalendarFields(input.target.current, input.target.recorded);
  const changedFields = description.trim() === input.target.current.description.trim() ? [] : ['description'];
  if (!canApplyCalendarUpdate({
    storedRevision: input.target.storedEtag,
    incomingRevision: input.target.current.etag,
    changedFields,
    lockedFields,
  })) return;
  const updated = await patchScheduledEvent({
    dependencies: input.dependencies,
    accessToken: input.accessToken,
    googleEventId: input.target.googleEventId,
    notify: false,
    body: { description },
  });
  await db.update(events).set({
    calendarDescription: description,
    calendarEtag: updated.etag ?? null,
    updatedAt: now(),
  }).where(eq(events.id, input.target.rowId)).run();
};

interface SchemaExtractionEffectArguments {
  organizationId: string;
  sourceMessageId: string;
  gmailMessageId: string;
  subject: string;
  receivedAt: string;
  recordedFolderId: string | null;
  rule: ActiveRule;
  extraction: MailExtraction;
  correlations: PlannedSchemaCorrelation[];
  attachments: SourceAttachment[];
  agentFailed: boolean;
}

const schemaPlannedEffects = (arguments_: SchemaExtractionEffectArguments) => [
  ...(arguments_.extraction.warnings.length ? [{ key: 'record-warnings', kind: 'schema.record_warnings', arguments: arguments_ as unknown as Record<string, unknown>, dependsOn: [] }] : []),
  { key: 'deliver-summary', kind: 'schema.deliver_summary', arguments: arguments_ as unknown as Record<string, unknown>, dependsOn: [] },
  ...(arguments_.extraction.tasks.length ? [{ key: 'create-tasks', kind: 'schema.create_tasks', arguments: arguments_ as unknown as Record<string, unknown>, dependsOn: [] }] : []),
  { key: 'apply-events', kind: 'schema.apply_events', arguments: arguments_ as unknown as Record<string, unknown>, dependsOn: [] },
];

/** Applies only the frozen output of Schema Rule planning; it never invokes AI. */
const applySchemaExtraction = async (
  dependencies: AutomationDependencies,
  database: D1Database,
  accessToken: string,
  input: SchemaExtractionEffectArguments,
  attachmentContents: SourceAttachmentContent[],
): Promise<void> => {
  const db = drizzleOrganizationDatabase(database);
  const { extraction, rule, sourceMessageId, subject, gmailMessageId } = input;
  const candidates = extraction.events;
  if (!candidates.length) {
    await db.update(sourceMessages).set({ state: input.agentFailed ? 'exception' : 'processed', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  let attachmentFolderId: string | null = null;
  if (attachmentContents.length) {
    try {
      attachmentFolderId = await resolveSourceMessageFolder({
        database: db, drive: dependencies.attachments, accessToken, subject,
        receivedAt: input.receivedAt, recordedFolderId: input.recordedFolderId,
        sourceMessageId,
      });
    } catch (error) {
      await db.insert(automationWarnings).values({
        id: crypto.randomUUID(), sourceMessageId, code: 'attachment_folder_unavailable',
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
    ? [{ filename: attachment.filename, url: publication.publicUrl }] : []);
  const calendarAttachments = publications.flatMap(({ attachment, publication }) => publication.publicUrl ? [{
    fileUrl: publication.publicUrl, title: attachment.filename, mimeType: attachment.mimeType,
  }] : []);
  const recordEventAttachments = async (eventId: string): Promise<void> => {
    for (const { attachment, publication } of publications) {
      await db.insert(eventAttachments).values({
        id: crypto.randomUUID(), eventId, gmailAttachmentId: attachment.attachmentId,
        filename: attachment.filename, mimeType: attachment.mimeType, byteSize: attachment.size,
        driveFileId: publication.driveFileId, publicUrl: publication.publicUrl,
        outcome: publication.outcome, createdAt: now(),
      }).run();
      await db.insert(deliveries).values({
        id: crypto.randomUUID(), eventId, channel: 'drive', destination: attachment.filename,
        outcome: publication.outcome, externalId: publication.driveFileId, createdAt: now(),
      }).run();
    }
  };
  if (extraction.kind === 'response') {
    const matched = new Map(input.correlations.map(({ candidateIndex, target }) => [candidateIndex, target]));
    const target = [...matched.values()][0];
    if (target) {
      await db.delete(guestRegistrations).where(and(
        eq(guestRegistrations.eventId, target.rowId), eq(guestRegistrations.sourceMessageId, sourceMessageId),
      )).run();
      if (extraction.guests.length) {
        await db.insert(guestRegistrations).values(extraction.guests.map((guest) => ({
          id: crypto.randomUUID(), eventId: target.rowId, sourceMessageId,
          name: guest.name, affiliation: guest.affiliation, attending: guest.attending, createdAt: now(),
        }))).run();
      }
      await recordEventAttachments(target.rowId);
      await rewriteScheduledEventDescription({ dependencies, database, accessToken, target, gmailMessageId });
    }
    await db.update(sourceMessages).set({
      state: publicationFailed || input.agentFailed ? 'exception' : 'processed', processedAt: now(),
    }).where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const invitees = await activeMemberInvitees(database);
  const attendees = publicationFailed ? [] : invitees;
  const mergeMatches = new Map(input.correlations.map(({ candidateIndex, target }) => [candidateIndex, target]));
  const calendarUrl = new URL(CALENDAR_EVENTS_URL);
  if (calendarAttachments.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  if (attendees.length) calendarUrl.searchParams.set('sendUpdates', 'all');
  for (const [index, candidate] of candidates.entries()) {
    const merged = mergeMatches.get(index);
    if (merged) {
      await mergeScheduledEvent({
        dependencies, database, accessToken, target: merged, candidate, attachmentLinks, gmailMessageId,
      });
      await recordEventAttachments(merged.rowId);
      continue;
    }
    const description = calendarEventDescription({
      summary: candidate.summary, attachments: attachmentLinks,
      attribution: sourceMessageAttribution(gmailMessageId),
    });
    const event = await dependencies.google.request<CalendarEventResource>(accessToken, calendarUrl.toString(), {
      method: 'POST',
      body: JSON.stringify({
        summary: candidate.title, description, location: candidate.location,
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
      id: eventId, organizationId: input.organizationId, ruleId: rule.id, sourceMessageId,
      googleEventId: event.id, title: candidate.title, startsAt: candidate.startsAt,
      endsAt: candidate.endsAt, location: candidate.location, description: candidate.summary,
      calendarDescription: description, calendarEtag: event.etag ?? null,
      status: publicationFailed ? 'draft' : 'scheduled', createdAt: eventCreatedAt, updatedAt: eventCreatedAt,
    }).run();
    await recordEventInvitations({
      database, eventId, googleEventId: event.id, invitees,
      outcome: publicationFailed ? 'pending' : 'succeeded',
    });
    await recordEventAttachments(eventId);
  }
  if (publicationFailed) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(), sourceMessageId, code: 'drive_attachment_publish_failed',
      message: '一部の添付ファイルを公開できませんでした。', state: 'open', createdAt: now(),
    }).run();
  }
  await db.update(sourceMessages).set({
    state: publicationFailed || input.agentFailed ? 'exception' : 'processed', processedAt: now(),
  }).where(eq(sourceMessages.id, sourceMessageId)).run();
};

const schemaRuleEffectPort = (input: {
  dependencies: AutomationDependencies;
  env: Bindings;
  database: D1Database;
  accessToken: string;
  cachedAttachmentContents?: SourceAttachmentContent[];
}): RuleEffectPort => ({
  apply: async ({ effect }) => {
    const arguments_ = effect.arguments as unknown as SchemaExtractionEffectArguments;
    const db = drizzleOrganizationDatabase(input.database);
    if (effect.kind === 'schema.record_warnings') {
      if (arguments_.extraction.warnings.length) await db.insert(automationWarnings).values(arguments_.extraction.warnings.map((warning) => ({
        id: crypto.randomUUID(), sourceMessageId: arguments_.sourceMessageId, code: warning.code, message: warning.message, createdAt: now(),
      }))).run();
    } else if (effect.kind === 'schema.deliver_summary') {
      await deliverSourceMessageNotice({
        dependencies: input.dependencies, env: input.env, database: input.database,
        organizationId: arguments_.organizationId, googleAccessToken: input.accessToken,
        sourceMessageId: arguments_.sourceMessageId, rule: arguments_.rule,
        subject: `Message Summary: ${arguments_.subject}`, body: arguments_.extraction.summary,
      });
    } else if (effect.kind === 'schema.create_tasks') {
      await createTaskWorkflow(db).createFromSourceMessage({
        organizationId: arguments_.organizationId,
        sourceMessageId: arguments_.sourceMessageId,
        sourceMessageSubject: arguments_.subject,
        extractedTasks: arguments_.extraction.tasks,
      });
    } else if (effect.kind === 'schema.apply_events') {
      const attachmentContents = input.cachedAttachmentContents ?? (arguments_.attachments.length
        ? await input.dependencies.attachments.read({
          accessToken: input.accessToken,
          gmailMessageId: arguments_.gmailMessageId,
          attachments: arguments_.attachments,
        })
        : []);
      await applySchemaExtraction(
        input.dependencies,
        input.database,
        input.accessToken,
        arguments_,
        attachmentContents,
      );
    } else {
      throw new Error(`Unsupported Rule Effect: ${effect.kind}`);
    }
    return { applied: true };
  },
});

export const schemaRuleEffectPortForApproval = async (input: {
  env: Bindings;
  database: D1Database;
  organizationId: string;
}): Promise<RuleEffectPort> => {
  const inbox = await activeAutomationInbox(input.database);
  const accessToken = await accessTokenForInbox(input.env, input.organizationId, input.database, inbox, productionDependencies);
  return schemaRuleEffectPort({ ...input, dependencies: productionDependencies, accessToken });
};

/** Resumes due effects without rerunning selection, AI, or planning. */
export const resumeDueRuleRuns = async (input: {
  env: Bindings;
  database: D1Database;
  organizationId: string;
}) => {
  let schemaPort: RuleEffectPort | undefined;
  const agentPorts = new Map<string, Awaited<ReturnType<typeof agentWritePortForApproval>>>();
  const execution = createRuleExecution({
    database: input.database,
    planner: { plan: async () => [] },
    effects: {
      apply: async (application) => {
        if (application.run.rule.type === 'schema') {
          schemaPort ??= await schemaRuleEffectPortForApproval(input);
          return schemaPort.apply(application);
        }
        let writes = agentPorts.get(application.run.rule.id);
        if (!writes) {
          writes = await agentWritePortForApproval({
            ...input,
            sourceMessageId: application.run.sourceMessageId,
            agentRuleId: application.run.rule.id,
          });
          agentPorts.set(application.run.rule.id, writes);
        }
        if (application.effect.kind === 'agent.send_line_message') {
          return writes.sendLine(application.effect.arguments as { destination: string; message: string });
        }
        if (application.effect.kind === 'agent.create_scheduled_event') {
          return writes.createScheduledEvent(application.effect.arguments as {
            destination: string; title: string; startsAt: string; endsAt: string; location?: string; description?: string;
          });
        }
        throw new Error(`Unsupported Rule Effect: ${application.effect.kind}`);
      },
    },
  });
  await execution.expireApprovals();
  return execution.resumeDue();
};

/** Starts a side-effect-free Draft run for one selected Schema Rule revision. */
export const startSchemaDraftRuleRun = async (input: {
  env: Bindings;
  database: D1Database;
  organizationId: string;
  ruleId: string;
  messageId: string;
  extraction: MailExtraction;
}) => {
  const db = drizzleOrganizationDatabase(input.database);
  const row = await db.select().from(automationRules).where(eq(automationRules.id, input.ruleId)).get();
  if (!row || row.status !== 'draft') throw new Error('Mailbox Test requires a Draft Schema Rule.');
  const [recipientReferences, lineReferences] = await Promise.all([
    db.select().from(rulePermittedRecipientLists).where(eq(rulePermittedRecipientLists.ruleId, row.id)).all(),
    db.select().from(rulePermittedLineLists).where(eq(rulePermittedLineLists.ruleId, row.id)).all(),
  ]);
  const rule: ActiveRule = {
    id: row.id,
    revision: row.currentRevision,
    priority: row.priority,
    executionMode: row.executionMode,
    selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
    taskRoleIds: JSON.parse(row.taskRoleIds) as string[],
    permittedRecipientListIds: recipientReferences.map(({ listId }) => listId),
    permittedLineListIds: lineReferences.map(({ listId }) => listId),
  };
  const source = await readMailboxTestSourceWithGoogle(
    input.env, input.organizationId, input.database, input.messageId, productionDependencies,
  );
  if (!ruleMatches(rule, { sender: source.sender, subject: source.subject, body: source.source })) {
    throw new Error('The selected Source Message does not match this Rule Selection Policy.');
  }
  const existing = await db.select({ id: sourceMessages.id, driveFolderId: sourceMessages.driveFolderId })
    .from(sourceMessages).where(eq(sourceMessages.gmailMessageId, input.messageId)).get();
  const sourceMessageId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const timestamp = now();
    await db.insert(sourceMessages).values({
      id: sourceMessageId,
      gmailMessageId: input.messageId,
      gmailHistoryId: `draft-preview:${input.messageId}`,
      sender: source.sender,
      subject: source.subject,
      receivedAt: source.receivedAt ?? timestamp,
      processedAt: timestamp,
      state: 'processed',
    }).run();
  }
  const allowedRoles = new Set(rule.taskRoleIds ?? []);
  const extraction: MailExtraction = {
    ...input.extraction,
    tasks: input.extraction.tasks.filter((task) => allowedRoles.has(task.assigneeRoleId)),
  };
  const arguments_: SchemaExtractionEffectArguments = {
    organizationId: input.organizationId,
    sourceMessageId,
    gmailMessageId: input.messageId,
    subject: source.subject,
    receivedAt: source.receivedAt ?? now(),
    recordedFolderId: existing?.driveFolderId ?? null,
    rule,
    extraction,
    correlations: await planSchemaCorrelations({
      env: input.env,
      organizationId: input.organizationId,
      database: input.database,
      dependencies: productionDependencies,
      accessToken: await accessTokenForInbox(
        input.env,
        input.organizationId,
        input.database,
        await activeAutomationInbox(input.database),
        productionDependencies,
      ),
      extraction,
    }),
    attachments: source.attachments.map(({ data: _, ...attachment }) => attachment),
    agentFailed: false,
  };
  const execution = createRuleExecution({
    database: input.database,
    planner: { plan: async () => [{
      rule: { type: 'schema', id: rule.id, revision: rule.revision },
      executionMode: 'read_only',
      effects: schemaPlannedEffects(arguments_),
    }] },
    effects: schemaRuleEffectPort({ dependencies: productionDependencies, env: input.env, database: input.database, accessToken: '' }),
  });
  return (await execution.start({ sourceMessageId, intent: { kind: 'draft_preview', ruleRevisionId: String(rule.revision) } }))[0]!;
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
      revision: automationRules.currentRevision,
      priority: automationRules.priority,
      executionMode: automationRules.executionMode,
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
      revision: row.revision,
      priority: row.priority,
      executionMode: row.executionMode,
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
  const schemaArguments: SchemaExtractionEffectArguments = {
    organizationId,
    sourceMessageId,
    gmailMessageId,
    subject,
    receivedAt: receivedAtOf(message.internalDate) ?? timestamp,
    recordedFolderId: known?.driveFolderId ?? null,
    rule,
    extraction,
    correlations: await planSchemaCorrelations({
      env,
      organizationId,
      database,
      dependencies,
      accessToken,
      extraction,
    }),
    attachments,
    agentFailed,
  };
  const schemaExecution = createRuleExecution({
    database,
    planner: { plan: async () => [{
      rule: { type: 'schema', id: rule.id, revision: rule.revision },
      executionMode: rule.executionMode,
      effects: schemaPlannedEffects(schemaArguments),
    }] },
    effects: schemaRuleEffectPort({
      dependencies,
      env,
      database,
      accessToken,
      cachedAttachmentContents: attachmentContents,
    }),
  });
  await schemaExecution.start({ sourceMessageId, intent: { kind: 'live' } });
  if (rule.executionMode !== 'unattended') {
    await db.update(sourceMessages).set({ state: agentFailed ? 'exception' : 'processed', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
  }
  return;
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
  await resumeDueRuleRuns({ env, database, organizationId });
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
      await resumeDueRuleRuns({ env, database: database.raw, organizationId: organization.id });
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
