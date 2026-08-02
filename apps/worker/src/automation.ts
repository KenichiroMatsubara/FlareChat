import { and, count, eq, isNotNull } from 'drizzle-orm';

import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { fromBase64Url } from './encoding';
import { buildAiEventDetailsRequest, type AiEventDetailsRequest, type EventDetails, type MailExtraction, type TaskRoleDescription } from './event-details';
import { createTaskWorkflow } from './tasks';
import type { SourceAttachmentContent } from './drive-attachments';
import type { GoogleTokenSet } from './google';
import { productionAutomationDependencies } from './automation/providers';
import type { AutomationDependencies, GoogleAutomationPort } from './automation/providers';
import { createDatabaseAccess } from './database-access';
import type { Bindings } from './types';
import { validateAttachmentIntake } from '@mail/domain';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizationKeys, organizations } from './storage/control-schema';
import {
  connections,
  deliveries,
  automationWarnings,
  eventAttachments,
  events,
  exceptions as automationExceptions,
  googleConnections,
  operationalTaskRoles,
  rules as automationRules,
  sourceMessages,
} from './storage/organization-schema';
import type { GoogleConnectionRecord } from './storage/organization-schema';

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

type AutomationInbox = GoogleConnectionRecord;

export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

export const LEGACY_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

interface EventCandidate {
  title: string;
  startsAt: string;
  endsAt: string;
}

export interface MailboxTestMatch {
  id: string;
  subject: string;
  sender: string;
}

export interface MailboxTestSource extends MailboxTestMatch {
  source: string;
  attachments: SourceAttachmentContent[];
}

export interface ActiveRule {
  id: string;
  priority: number;
  selectionPolicy: Record<string, unknown>;
  taskRoleIds?: string[];
}

export interface RuleSource {
  sender: string;
  subject: string;
  body: string;
  labels?: string[];
}

const now = (): string => new Date().toISOString();

const productionDependencies = productionAutomationDependencies;

const decodedBody = (part: GmailPart | undefined): string => {
  if (!part) return '';
  const own = part.body?.data ? new TextDecoder().decode(fromBase64Url(part.body.data)) : '';
  const nested = part.parts?.map(decodedBody).join('\n') ?? '';
  return `${own}\n${nested}`.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
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

const padded = (value: number): string => String(value).padStart(2, '0');

const japanDateTime = (year: number, month: number, day: number, hour: number, minute: number): string =>
  `${year}-${padded(month)}-${padded(day)}T${padded(hour)}:${padded(minute)}:00+09:00`;

/** Extracts an event only when the message states both a date and a time range. */
export const extractEventCandidate = (subject: string, body: string, current = new Date()): EventCandidate | null => {
  const text = `${subject}\n${body}`;
  const date = text.match(/(?:(\d{4})\s*(?:年|[/-]))?\s*(\d{1,2})\s*(?:月|[/-])\s*(\d{1,2})\s*日?/u);
  const time = text.match(/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(?:時)?\s*(?:-|〜|～|to)\s*(\d{1,2})(?::(\d{2}))?\s*(?:時)?/iu);
  if (!date || !time) return null;
  const year = date[1] ? Number(date[1]) : current.getFullYear();
  const month = Number(date[2]);
  const day = Number(date[3]);
  const startHour = Number(time[1]);
  const startMinute = Number(time[2] ?? '0');
  const endHour = Number(time[3]);
  const endMinute = Number(time[4] ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31 || startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  return {
    title: subject.replace(/^(?:re|fw|fwd)\s*:\s*/iu, '').trim() || 'メールから作成した予定',
    startsAt: japanDateTime(year, month, day, startHour, startMinute),
    endsAt: japanDateTime(year, month, day, endHour, endMinute),
  };
};

/** Chooses exactly one active Rule, using descending priority after policy matching. */
export const selectActiveRule = (rules: ActiveRule[], source: RuleSource): ActiveRule | null => {
  const sender = source.sender.trim().toLowerCase();
  const domain = sender.split('@')[1] ?? '';
  const content = `${source.subject}\n${source.body}`.toLowerCase();
  const matching = rules.filter((rule) => {
    const policy = rule.selectionPolicy;
    const requiredSender = typeof policy.sender === 'string' ? policy.sender.trim().toLowerCase() : '';
    const requiredDomain = typeof policy.domain === 'string' ? policy.domain.trim().toLowerCase() : '';
    const requiredKeyword = typeof policy.keyword === 'string' ? policy.keyword.trim().toLowerCase() : '';
    const requiredLabel = typeof policy.label === 'string' ? policy.label.trim() : '';
    return (!requiredSender || requiredSender === sender)
      && (!requiredDomain || requiredDomain === domain)
      && (!requiredKeyword || content.includes(requiredKeyword))
      && (!requiredLabel || (source.labels ?? []).includes(requiredLabel));
  });
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

const accessTokenForInbox = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
  dependencies: AutomationDependencies,
): Promise<string> => {
  const key = await organizationKeyFor(env, organizationId);
  const token = JSON.parse(await decrypt(JSON.parse(inbox.tokenEnvelope), key, `google-connection:${organizationId}:automation-inbox`)) as GoogleTokenSet;
  if (Date.parse(token.expiresAt) > Date.now() + 60_000) return token.accessToken;
  const refreshed = await dependencies.tokens.refresh({
    refreshToken: token.refreshToken,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
  const envelope = await encrypt(JSON.stringify(refreshed), key, `google-connection:${organizationId}:automation-inbox`);
  await drizzleOrganizationDatabase(database).update(googleConnections)
    .set({ tokenEnvelope: JSON.stringify(envelope), updatedAt: now() })
    .where(eq(googleConnections.id, inbox.id))
    .run();
  return refreshed.accessToken;
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
    await db.update(googleConnections).set({
      status: 'reauthentication_required',
      lastError: error instanceof Error ? error.message : 'Automation Inbox token refresh failed.',
      updatedAt: now(),
    }).where(eq(googleConnections.id, inbox.id)).run();
  }
};

interface AiCredential {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Uses the Organization-scoped OpenAI-compatible connection when it is configured. */
const aiExtraction = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
  taskRoles: TaskRoleDescription[],
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
      taskRoles,
      markdown: env.AI,
    });
  } catch {
    return null;
  }
};

/** Reuses the production AI provider for a confirmed, manual Mailbox Test preview. */
const extractMailboxTestPackage = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
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
    taskRoles,
    markdown: env.AI,
  });
};

/** Produces the exact bounded OpenAI-compatible payload for review before sending. */
const previewMailboxTestAiRequest = async (
  env: Bindings,
  input: { database: D1Database; source: string; attachments: SourceAttachmentContent[] },
): Promise<AiEventDetailsRequest> => {
  const taskRoles = await drizzleOrganizationDatabase(input.database).select({
    id: operationalTaskRoles.id,
    displayName: operationalTaskRoles.displayName,
    description: operationalTaskRoles.description,
  }).from(operationalTaskRoles).all();
  return buildAiEventDetailsRequest({
    source: input.source,
    attachments: input.attachments,
    taskRoles,
    markdown: env.AI,
  });
};

const mailboxMessage = async (google: GoogleAutomationPort, accessToken: string, messageId: string): Promise<GmailMessage> =>
  google.request<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`);

const exactSubject = (subject: string, expected: string): boolean => subject.normalize('NFC') === expected.normalize('NFC');

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
  return {
    id: message.id,
    subject,
    sender: senderOf(message.payload),
    source: `${subject}\n${body}`,
    attachments: await dependencies.attachments.read({ accessToken, gmailMessageId: message.id, attachments }),
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
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: await dependencies.attachments.publish({
      accessToken,
      attachment,
    }),
  })));
  if (publications.some(({ publication }) => publication.outcome === 'failed')) {
    throw new Error('添付ファイルを公開できなかったため、テスト予定を作成しませんでした。');
  }
  const calendarUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  if (publications.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  const created = await Promise.all(input.events.map(async (details) => {
    const event = await dependencies.google.request<CalendarEvent>(accessToken, calendarUrl.toString(), {
      method: 'POST',
      body: JSON.stringify({
        summary: details.title,
        description: `${details.description}\n\nMail Automation の手動テストで Gmail メッセージ ${input.messageId} から作成しました。`.trim(),
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

const processOrganizationMessage = async (
  dependencies: AutomationDependencies,
  env: Bindings,
  database: D1Database,
  organizationId: string,
  accessToken: string,
  gmailHistoryId: string,
  gmailMessageId: string,
): Promise<void> => {
  const db = drizzleOrganizationDatabase(database);
  const known = await db.select({ id: sourceMessages.id }).from(sourceMessages)
    .where(eq(sourceMessages.gmailMessageId, gmailMessageId)).get();
  if (known) return;
  const message = await dependencies.google.request<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`);
  const subject = subjectOf(message.payload);
  const sourceMessageId = crypto.randomUUID();
  const timestamp = now();
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
  const body = decodedBody(message.payload) || (message.snippet ?? '');
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
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const activeRules = await db.select({
    id: automationRules.id,
    priority: automationRules.priority,
    selectionPolicy: automationRules.selectionPolicy,
    taskRoleIds: automationRules.taskRoleIds,
  }).from(automationRules).where(eq(automationRules.status, 'active')).orderBy(automationRules.priority).all();
  const rule = selectActiveRule(activeRules.flatMap((row) => {
    try { return [{ id: row.id, priority: row.priority, selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>, taskRoleIds: JSON.parse(row.taskRoleIds) as string[] }]; }
    catch { return []; }
  }), { sender: senderOf(message.payload), subject, body, ...(message.labelIds === undefined ? {} : { labels: message.labelIds }) });
  if (!rule) {
    await db.update(sourceMessages).set({ state: 'skipped', processedAt: now() })
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
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
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
  const extraction = await aiExtraction(env, organizationId, database, `${subject}\n${body}`, attachmentContents, allowedTaskRoles, dependencies);
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
  const fallbackCandidate = extractEventCandidate(subject, body);
  const candidates = extraction?.events.map((event) => ({ title: event.title, startsAt: event.startsAt, endsAt: event.endsAt })) ?? (fallbackCandidate ? [fallbackCandidate] : []);
  if (!candidates.length) {
    await db.update(sourceMessages).set({ state: 'skipped', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  if (extraction?.tasks.length) {
    await createTaskWorkflow(db).createFromSourceMessage({
      organizationId,
      sourceMessageId,
      sourceMessageSubject: subject,
      extractedTasks: extraction.tasks,
    });
  }
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: await dependencies.attachments.publish({ accessToken, attachment }),
  })));
  const publicationFailed = publications.some(({ publication }) => publication.outcome === 'failed');
  const publicUrls = publications.flatMap(({ publication }) => publication.publicUrl ? [publication.publicUrl] : []);
  const calendarAttachments = publications.flatMap(({ attachment, publication }) => publication.publicUrl ? [{
    fileUrl: publication.publicUrl,
    title: attachment.filename,
    mimeType: attachment.mimeType,
  }] : []);
  const calendarUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  if (calendarAttachments.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  for (const candidate of candidates) {
    const event = await dependencies.google.request<CalendarEvent>(accessToken, calendarUrl.toString(), {
      method: 'POST',
      body: JSON.stringify({
        summary: candidate.title,
        description: `Mail Automation が Gmail メッセージ ${gmailMessageId} から作成しました。${publicUrls.length ? `\n\n添付ファイル:\n${publicUrls.join('\n')}` : ''}`,
        start: { dateTime: candidate.startsAt, timeZone: 'Asia/Tokyo' },
        end: { dateTime: candidate.endsAt, timeZone: 'Asia/Tokyo' },
        attachments: calendarAttachments,
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
    state: publicationFailed ? 'exception' : 'processed',
    processedAt: now(),
  }).where(eq(sourceMessages.id, sourceMessageId)).run();
};

const runOrganizationInbox = async (
  dependencies: AutomationDependencies,
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
): Promise<void> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, inbox, dependencies);
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
        if (message.message?.id) await processOrganizationMessage(dependencies, env, database, organizationId, accessToken, inbox.gmailHistoryId, message.message.id);
      }
    }
    historyId = history.historyId ?? historyId;
    pageToken = history.nextPageToken;
  } while (pageToken);
  const syncedAt = now();
  await drizzleOrganizationDatabase(database).update(googleConnections)
    .set({ gmailHistoryId: historyId, lastSyncedAt: syncedAt, lastError: null, updatedAt: syncedAt })
    .where(eq(googleConnections.id, inbox.id))
    .run();
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
  const before = await automationCounts(database);
  await runOrganizationInbox(dependencies, env, organizationId, database, inbox);
  const after = await automationCounts(database);
  return {
    scanned: after.scanned - before.scanned,
    created: after.created - before.created,
    skipped: after.skipped - before.skipped,
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
    const database = await databases.open({
      kind: 'organization',
      bindingName: organization.bindingName,
      databaseId: organization.databaseId,
    });
    const orgDb = drizzleOrganizationDatabase(database.raw);
    const inboxes = await orgDb.select().from(googleConnections).where(and(
      eq(googleConnections.kind, 'automation_inbox'),
      eq(googleConnections.status, 'active'),
      eq(googleConnections.enabled, true),
    )).all();
    for (const inbox of inboxes) {
      try {
        await runOrganizationInbox(dependencies, env, organization.id, database.raw, inbox);
      } catch (error) {
        await orgDb.update(googleConnections).set({
          status: 'reauthentication_required',
          lastError: error instanceof Error ? error.message : 'Automation Inbox failed.',
          updatedAt: now(),
        }).where(eq(googleConnections.id, inbox.id)).run();
      }
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
      extractPackage: (input: { organizationId: string; database: D1Database; source: string; attachments: SourceAttachmentContent[] }): Promise<MailExtraction | null> =>
        extractMailboxTestPackage(env, input.organizationId, input.database, input.source, input.attachments, dependencies),
      previewAiRequest: (input: { database: D1Database; source: string; attachments: SourceAttachmentContent[] }): Promise<AiEventDetailsRequest> =>
        previewMailboxTestAiRequest(env, input),
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
