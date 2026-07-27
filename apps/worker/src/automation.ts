import { and, count, eq, isNotNull } from 'drizzle-orm';

import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { fromBase64Url } from './encoding';
import { extractGeminiEventDetails } from './event-details';
import type { EventDetails } from './event-details';
import { publishDriveAttachment, readGmailAttachments } from './drive-attachments';
import type { SourceAttachmentContent } from './drive-attachments';
import { refreshGoogleToken } from './google';
import type { GoogleTokenSet } from './google';
import { organizationDatabase } from './organization-db';
import type { Bindings } from './types';
import { validateAttachmentIntake } from '@mail/domain';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizationKeys, organizations } from './storage/control-schema';
import {
  connections,
  deliveries,
  eventAttachments,
  events,
  exceptions as automationExceptions,
  googleConnections,
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
}

export interface RuleSource {
  sender: string;
  subject: string;
  body: string;
  labels?: string[];
}

const now = (): string => new Date().toISOString();

const googleFetch = async <T>(accessToken: string, url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? 'Google API request failed.');
  return body;
};

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
): Promise<string> => {
  const key = await organizationKeyFor(env, organizationId);
  const token = JSON.parse(await decrypt(JSON.parse(inbox.tokenEnvelope), key, `google-connection:${organizationId}:automation-inbox`)) as GoogleTokenSet;
  if (Date.parse(token.expiresAt) > Date.now() + 60_000) return token.accessToken;
  const refreshed = await refreshGoogleToken({
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

/** Uses the Organization-scoped Gemini connection when it is configured. */
const geminiDetails = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
): Promise<EventDetails | null | undefined> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) return undefined;
  try {
    const key = await organizationKeyFor(env, organizationId);
    const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as { provider?: string; apiKey?: string; model?: string };
    if (credential.provider !== 'Google Gemini API' || !credential.apiKey || !credential.model) return null;
    return extractGeminiEventDetails({ apiKey: credential.apiKey, model: credential.model, source, attachments });
  } catch {
    return null;
  }
};

const geminiCandidate = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
  attachments: SourceAttachmentContent[],
): Promise<EventCandidate | null | undefined> => {
  const details = await geminiDetails(env, organizationId, database, source, attachments);
  return details && { title: details.title, startsAt: details.startsAt, endsAt: details.endsAt };
};

const mailboxMessage = async (accessToken: string, messageId: string): Promise<GmailMessage> =>
  googleFetch<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`);

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
export const searchMailboxForTest = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  subject: string,
): Promise<MailboxTestMatch[]> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database));
  const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  query.searchParams.set('q', `subject:"${subject.replaceAll('"', '\\"')}"`);
  query.searchParams.set('maxResults', '10');
  const results = await googleFetch<GmailMessageList>(accessToken, query.toString());
  const messages = await Promise.all((results.messages ?? []).flatMap((value) => value.id ? [mailboxMessage(accessToken, value.id)] : []));
  return messages.flatMap((message) => {
    const foundSubject = subjectOf(message.payload);
    if (!message.id || !exactSubject(foundSubject, subject)) return [];
    return [{ id: message.id, subject: foundSubject, sender: senderOf(message.payload) }];
  });
};

/** Reads one selected message from the Organization's Automation Inbox for a server-side AI preview. */
export const readMailboxTestSource = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  messageId: string,
): Promise<MailboxTestSource> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database));
  const message = await mailboxMessage(accessToken, messageId);
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
    attachments: await readGmailAttachments({ accessToken, gmailMessageId: message.id, attachments }),
  };
};

/** Creates a Calendar event only after a separately confirmed, encrypted test preview. */
export const createMailboxTestCalendarEvent = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  input: { messageId: string; event: EventDetails },
): Promise<{ eventId: string }> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, await activeAutomationInbox(database));
  const message = await mailboxMessage(accessToken, input.messageId);
  const attachments = sourceAttachments(message.payload);
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const attachmentContents = await readGmailAttachments({ accessToken, gmailMessageId: input.messageId, attachments });
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: await publishDriveAttachment({
      accessToken,
      attachment,
    }),
  })));
  if (publications.some(({ publication }) => publication.outcome === 'failed')) {
    throw new Error('添付ファイルを公開できなかったため、テスト予定を作成しませんでした。');
  }
  const calendarUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  if (publications.length) calendarUrl.searchParams.set('supportsAttachments', 'true');
  const event = await googleFetch<CalendarEvent>(accessToken, calendarUrl.toString(), {
    method: 'POST',
    body: JSON.stringify({
      summary: input.event.title,
      description: `${input.event.description}\n\nMail Automation の手動テストで Gmail メッセージ ${input.messageId} から作成しました。`.trim(),
      location: input.event.location,
      start: { dateTime: input.event.startsAt, timeZone: input.event.timeZone },
      end: { dateTime: input.event.endsAt, timeZone: input.event.timeZone },
      attachments: publications.map(({ attachment, publication }) => ({
        fileUrl: publication.publicUrl,
        title: attachment.filename,
        mimeType: attachment.mimeType,
      })),
    }),
  });
  if (!event.id) throw new Error('Google Calendar が予定 ID を返しませんでした。');
  return { eventId: event.id };
};

const processOrganizationMessage = async (
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
  const message = await googleFetch<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`);
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
  }).from(automationRules).where(eq(automationRules.status, 'active')).orderBy(automationRules.priority).all();
  const rule = selectActiveRule(activeRules.flatMap((row) => {
    try { return [{ id: row.id, priority: row.priority, selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown> }]; }
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
    attachmentContents = await readGmailAttachments({
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
  const aiCandidate = await geminiCandidate(env, organizationId, database, `${subject}\n${body}`, attachmentContents);
  if (aiCandidate === null) {
    await db.insert(automationExceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId,
      code: 'gemini_event_details_invalid',
      message: 'Gemini could not produce safe Event Details.',
      state: 'open',
      createdAt: now(),
    }).run();
    await db.update(sourceMessages).set({ state: 'exception', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const candidate = aiCandidate ?? extractEventCandidate(subject, body);
  if (!candidate) {
    await db.update(sourceMessages).set({ state: 'skipped', processedAt: now() })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
    return;
  }
  const publications = await Promise.all(attachmentContents.map(async (attachment) => ({
    attachment,
    publication: await publishDriveAttachment({ accessToken, attachment }),
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
  const event = await googleFetch<CalendarEvent>(accessToken, calendarUrl.toString(), {
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
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
): Promise<void> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, inbox);
  let pageToken: string | undefined;
  let historyId = inbox.gmailHistoryId;
  do {
    const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    query.searchParams.set('startHistoryId', inbox.gmailHistoryId);
    query.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) query.searchParams.set('pageToken', pageToken);
    const history = await googleFetch<GmailHistory>(accessToken, query.toString());
    for (const entry of history.history ?? []) {
      for (const message of entry.messagesAdded ?? []) {
        if (message.message?.id) await processOrganizationMessage(env, database, organizationId, accessToken, inbox.gmailHistoryId, message.message.id);
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

export const runOrganizationAutomation = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
): Promise<AutomationSummary> => {
  const db = drizzleOrganizationDatabase(database);
  const inbox = await db.select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
    eq(googleConnections.enabled, true),
  )).limit(1).get();
  if (!inbox) throw new Error('有効な Automation Inbox が見つかりません。');
  const before = await automationCounts(database);
  await runOrganizationInbox(env, organizationId, database, inbox);
  const after = await automationCounts(database);
  return {
    scanned: after.scanned - before.scanned,
    created: after.created - before.created,
    skipped: after.skipped - before.skipped,
    exceptions: after.exceptions - before.exceptions,
  };
};

export const runEnabledAutomations = async (env: Bindings): Promise<void> => {
  const activeOrganizations = await drizzleControlDatabase(env.CONTROL_DB).select({
    id: organizations.id,
    bindingName: organizations.bindingName,
    databaseId: organizations.databaseId,
  }).from(organizations).where(and(
    eq(organizations.status, 'active'),
    isNotNull(organizations.databaseId),
  )).orderBy(organizations.updatedAt).limit(20).all();
  for (const organization of activeOrganizations) {
    const database = organizationDatabase(env, organization.bindingName, organization.databaseId);
    if (!database) continue;
    const orgDb = drizzleOrganizationDatabase(database);
    const inboxes = await orgDb.select().from(googleConnections).where(and(
      eq(googleConnections.kind, 'automation_inbox'),
      eq(googleConnections.status, 'active'),
      eq(googleConnections.enabled, true),
    )).all();
    for (const inbox of inboxes) {
      try {
        await runOrganizationInbox(env, organization.id, database, inbox);
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
