/**
 * Mailbox Test and Draft Rule Preview (ADR 0136, ADR 0134): an operator's way of
 * proving that one selected Source Message would be handled as live Automation
 * handles it, through the same selection, extraction, and planning path, with no
 * business effect until a separately confirmed step asks for one.
 */

import { and, eq } from 'drizzle-orm';
import { validateAttachmentIntake } from '@mail/domain';

import { requiredAiConnection } from './ai';
import { resolveSourceMessageFolder } from './attachment-folders';
import {
  activeSchemaRules,
  assignableContacts,
  decodedBody,
  preparePrimarySchema,
  receivedAtOf,
  ruleMatches,
  schemaPlan,
  senderOf,
  sourceAttachments,
  subjectOf,
  type ActiveRule,
} from './source';
import { planSchemaCorrelations } from './calendar';
import { calendarEventDescription } from './event-description';
import { buildAiEventDetailsRequest, type AiEventDetailsRequest, type EventDetails, type MailExtraction } from './event-details';
import { sourceMessageAttribution } from './event-refresh';
import { ruleExecutionFor, type RuleRunView } from './execution';
import { openInbox, type InboxSession } from './inbox';
import type { GmailMessage, Providers, SourceAttachmentContent } from './providers';
import { applyEventRefresh, planEventRefresh, previewEventRefreshRequest } from './refresh';
import { accountDatabase } from './storage/database';
import { rulePermittedLineLists, rulePermittedRecipientLists, rules as schemaRules, sourceMessages } from './storage/account-schema';
import type { Bindings } from './types';

export interface MailboxTestMatch {
  id: string;
  subject: string;
  sender: string;
}

export interface MailboxTestSource extends MailboxTestMatch {
  source: string;
  attachments: SourceAttachmentContent[];
  receivedAt?: string;
  labels?: string[];
}

interface AccountInput {
  accountId: string;
  database: D1Database;
}

/**
 * Folds a subject down to the characters that carry meaning: Unicode-width
 * variants collapse together, and any run of whitespace — including a full-width
 * space — collapses to one. An operator pasting a subject from Gmail should not
 * have a test fail over an invisible trailing space Gmail itself ignores.
 */
const normalizedSubject = (subject: string): string => subject.normalize('NFKC').trim().replace(/\s+/gu, ' ');

const exactSubject = (subject: string, expected: string): boolean => normalizedSubject(subject) === normalizedSubject(expected);

const readMessage = async (session: InboxSession, providers: Providers, messageId: string): Promise<GmailMessage> => {
  const message = await providers.google.gmail.readMessage(session.accessToken, messageId);
  if (!message.id) throw new Error('Gmail メッセージを取得できませんでした。');
  return message;
};

/** Finds recent exact-subject matches in the Automation Inbox without changing Gmail state or the history boundary. */
const searchMailbox = async (session: InboxSession, providers: Providers, subject: string): Promise<MailboxTestMatch[]> => {
  const ids = await providers.google.gmail.searchMessages(session.accessToken, {
    query: `subject:"${subject.replaceAll('"', '\\"')}"`,
    maxResults: 10,
  });
  const messages = await Promise.all(ids.map((id) => providers.google.gmail.readMessage(session.accessToken, id)));
  return messages.flatMap((message) => {
    const foundSubject = subjectOf(message.payload);
    if (!message.id || !exactSubject(foundSubject, subject)) return [];
    return [{ id: message.id, subject: foundSubject, sender: senderOf(message.payload) }];
  });
};

/** Reads one selected message from the Automation Inbox for a server-side AI preview. */
const readSource = async (session: InboxSession, providers: Providers, messageId: string): Promise<MailboxTestSource> => {
  const message = await readMessage(session, providers, messageId);
  const subject = subjectOf(message.payload);
  const body = decodedBody(message.payload) || (message.snippet ?? '');
  const attachments = sourceAttachments(message.payload);
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const receivedAt = receivedAtOf(message.internalDate);
  return {
    id: message.id!,
    subject,
    sender: senderOf(message.payload),
    source: `${subject}\n${body}`,
    attachments: await session.readAttachments(message.id!, attachments),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(message.labelIds === undefined ? {} : { labels: message.labelIds }),
  };
};

/** Previews the selected Gmail message with the same active Primary Rule and extraction path as live Automation. */
const previewWithActiveRule = async (
  env: Bindings,
  providers: Providers,
  input: AccountInput & { session: InboxSession; messageId: string },
): Promise<{ source: MailboxTestSource; rule: ActiveRule; extraction: MailExtraction }> => {
  const source = await readSource(input.session, providers, input.messageId);
  const preparation = await preparePrimarySchema({
    env,
    accountId: input.accountId,
    database: input.database,
    providers,
    source: {
      sender: source.sender,
      subject: source.subject,
      body: source.source,
      ...(source.labels === undefined ? {} : { labels: source.labels }),
    },
    extractionSource: source.source,
    attachments: source.attachments,
    ...(source.receivedAt === undefined ? {} : { receivedAt: source.receivedAt }),
  });
  if (preparation.kind === 'no_matching_rule') throw new Error('このメールに一致する有効な Primary Rule がありません。');
  if (preparation.kind === 'ai_connection_missing') throw new Error('先に OpenAI 互換 API を設定してください。');
  if (preparation.kind === 'invalid_extraction') throw new Error('メールから安全な予定を抽出できませんでした。日付・開始時刻・終了時刻を確認してください。');
  return { source, rule: preparation.rule, extraction: preparation.extraction };
};

/** Creates Calendar events only after the caller has separately confirmed an encrypted Mailbox Test preview. */
const createCalendarEvents = async (
  providers: Providers,
  input: AccountInput & { session: InboxSession; messageId: string; events: EventDetails[] },
): Promise<{ eventIds: string[] }> => {
  const { google } = providers;
  const { accessToken } = input.session;
  const message = await readMessage(input.session, providers, input.messageId);
  const attachments = sourceAttachments(message.payload);
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const contents = await input.session.readAttachments(input.messageId, attachments);
  const folderId = contents.length ? await resolveSourceMessageFolder({
    database: accountDatabase(input.database),
    drive: google.drive,
    accessToken,
    subject: subjectOf(message.payload),
    receivedAt: receivedAtOf(message.internalDate) ?? new Date().toISOString(),
  }) : null;
  const publications = await Promise.all(contents.map(async (attachment) => ({
    attachment,
    publication: folderId
      ? await google.drive.publishAttachment(accessToken, { attachment, parentFolderId: folderId })
      : { outcome: 'failed' as const, driveFileId: null, publicUrl: null },
  })));
  if (publications.some(({ publication }) => publication.outcome === 'failed')) {
    throw new Error('添付ファイルを公開できなかったため、テスト予定を作成しませんでした。');
  }
  const attachmentLinks = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ filename: attachment.filename, url: publication.publicUrl }]
    : []);
  const calendarAttachments = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ fileUrl: publication.publicUrl, title: attachment.filename, mimeType: attachment.mimeType }]
    : []);
  const eventIds = await Promise.all(input.events.map(async (details) => {
    const event = await google.calendar.createEvent(accessToken, {
      summary: details.title,
      description: calendarEventDescription({
        summary: details.summary,
        attachments: attachmentLinks,
        attribution: sourceMessageAttribution(input.messageId),
      }),
      location: details.location,
      start: { dateTime: details.startsAt, timeZone: details.timeZone },
      end: { dateTime: details.endsAt, timeZone: details.timeZone },
      attachments: calendarAttachments,
    });
    if (!event.id) throw new Error('Google Calendar が予定 ID を返しませんでした。');
    return event.id;
  }));
  return { eventIds };
};

/** Reuses the production AI provider for a confirmed, manual Mailbox Test preview. */
const extractPackage = async (
  env: Bindings,
  providers: Providers,
  input: AccountInput & { source: string; attachments: SourceAttachmentContent[]; receivedAt?: string },
): Promise<MailExtraction | null> => {
  const connection = await requiredAiConnection(env, input.accountId, input.database);
  const roster = await assignableContacts(input.database);
  return providers.ai.extract({
    ...connection,
    source: input.source,
    attachments: input.attachments,
    ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
    roster,
    markdown: env.AI,
  });
};

/** Produces the exact bounded OpenAI-compatible payload for review before sending. */
const previewAiRequest = async (
  env: Bindings,
  input: { database: D1Database; source: string; attachments: SourceAttachmentContent[]; receivedAt?: string },
): Promise<AiEventDetailsRequest> => buildAiEventDetailsRequest({
  source: input.source,
  attachments: input.attachments,
  ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
  roster: await assignableContacts(input.database),
  markdown: env.AI,
});

/** Evaluates a Draft Schema Rule before making the Mailbox Test's AI request. */
const previewDraftRule = async (
  env: Bindings,
  providers: Providers,
  input: AccountInput & { session: InboxSession; ruleId: string; messageId: string },
): Promise<{ source: MailboxTestSource; rule: ActiveRule; extraction: MailExtraction }> => {
  const rule = await accountDatabase(input.database).select().from(schemaRules).where(eq(schemaRules.id, input.ruleId)).get();
  if (!rule || rule.status !== 'draft') throw new Error('Mailbox Test requires a Draft Schema Rule.');
  const source = await readSource(input.session, providers, input.messageId);
  if (!ruleMatches({ selectionPolicy: JSON.parse(rule.selectionPolicy) as Record<string, unknown> }, {
    sender: source.sender, subject: source.subject, body: source.source,
  })) {
    throw new Error('The selected Source Message does not match this Rule Selection Policy.');
  }
  const extraction = await extractPackage(env, providers, {
    accountId: input.accountId, database: input.database, source: source.source, attachments: source.attachments,
    ...(source.receivedAt === undefined ? {} : { receivedAt: source.receivedAt }),
  });
  if (!extraction) throw new Error('メールから安全な予定を抽出できませんでした。日付・開始時刻・終了時刻を確認してください。');
  return {
    source,
    rule: {
      id: rule.id,
      revision: rule.currentRevision,
      priority: rule.priority,
      executionMode: rule.executionMode,
      selectionPolicy: JSON.parse(rule.selectionPolicy) as Record<string, unknown>,
    },
    extraction,
  };
};

/** Starts a side-effect-free Draft run for one selected Schema Rule revision. */
const startDraftRuleRun = async (
  env: Bindings,
  providers: Providers,
  input: AccountInput & { session: InboxSession; ruleId: string; ruleRevision: number; messageId: string; extraction: MailExtraction },
): Promise<RuleRunView> => {
  const db = accountDatabase(input.database);
  const row = await db.select().from(schemaRules).where(eq(schemaRules.id, input.ruleId)).get();
  if (!row || row.status !== 'draft') throw new Error('Mailbox Test requires a Draft Schema Rule.');
  if (row.currentRevision !== input.ruleRevision) throw new Error('確認した Rule Revision と異なります。');
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
    permittedRecipientListIds: recipientReferences.map(({ listId }) => listId),
    permittedLineListIds: lineReferences.map(({ listId }) => listId),
    noticeContactListId: row.noticeContactListId,
  };
  const source = await readSource(input.session, providers, input.messageId);
  if (!ruleMatches(rule, { sender: source.sender, subject: source.subject, body: source.source })) {
    throw new Error('The selected Source Message does not match this Rule Selection Policy.');
  }
  // Rule Run needs a Source Message foreign key, but a preview must never mark
  // the real Gmail message as known: doing so would make live Automation skip it.
  const previewSourceKey = `draft-preview:${input.messageId}:${rule.id}:${rule.revision}`;
  const existing = await db.select({ id: sourceMessages.id, driveFolderId: sourceMessages.driveFolderId })
    .from(sourceMessages).where(eq(sourceMessages.gmailMessageId, previewSourceKey)).get();
  const sourceMessageId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const timestamp = new Date().toISOString();
    await db.insert(sourceMessages).values({
      id: sourceMessageId,
      gmailMessageId: previewSourceKey,
      gmailHistoryId: previewSourceKey,
      sender: source.sender,
      subject: source.subject,
      receivedAt: source.receivedAt ?? timestamp,
      processedAt: timestamp,
      state: 'processed',
    }).run();
  }
  const correlations = await planSchemaCorrelations({
    env, accountId: input.accountId, database: input.database, providers,
    accessToken: input.session.accessToken, extraction: input.extraction,
  });
  const execution = ruleExecutionFor({ env, database: input.database, accountId: input.accountId, providers, inbox: input.session });
  const runs = await execution.start({
    sourceMessageId,
    intent: { kind: 'draft_preview', ruleRevisionId: String(rule.revision) },
    plan: async () => [{
      rule: { type: 'schema', id: rule.id, revision: rule.revision },
      executionMode: 'read_only',
      effects: schemaPlan({
        accountId: input.accountId,
        sourceMessageId,
        gmailMessageId: input.messageId,
        subject: source.subject,
        receivedAt: source.receivedAt ?? new Date().toISOString(),
        recordedFolderId: existing?.driveFolderId ?? null,
        rule,
        extraction: input.extraction,
        correlations,
        attachments: source.attachments.map(({ data: _, ...attachment }) => attachment),
      }),
    }],
  });
  return runs[0]!;
};

const session = (env: Bindings, providers: Providers, input: AccountInput): Promise<InboxSession> =>
  openInbox({ env, accountId: input.accountId, database: input.database, google: providers.google });

/** The Mailbox Test use-cases, each opening the Automation Inbox for itself. */
export const mailboxTests = (env: Bindings, providers: Providers) => ({
  search: async (input: AccountInput & { subject: string }): Promise<MailboxTestMatch[]> =>
    searchMailbox(await session(env, providers, input), providers, input.subject),
  readSource: async (input: AccountInput & { messageId: string }): Promise<MailboxTestSource> =>
    readSource(await session(env, providers, input), providers, input.messageId),
  preview: async (input: AccountInput & { messageId: string }) =>
    previewWithActiveRule(env, providers, { ...input, session: await session(env, providers, input) }),
  createCalendarEvents: async (input: AccountInput & { messageId: string; events: EventDetails[] }) =>
    createCalendarEvents(providers, { ...input, session: await session(env, providers, input) }),
  extractPackage: (input: AccountInput & { source: string; attachments: SourceAttachmentContent[]; receivedAt?: string }) =>
    extractPackage(env, providers, input),
  previewAiRequest: (input: { database: D1Database; source: string; attachments: SourceAttachmentContent[]; receivedAt?: string }) =>
    previewAiRequest(env, input),
  previewRefreshRequest: async (input: AccountInput & { messageId: string; events: EventDetails[] }) =>
    previewEventRefreshRequest(providers, { ...input, session: await session(env, providers, input) }),
  planRefresh: async (input: AccountInput & { messageId: string; events: EventDetails[] }) =>
    planEventRefresh(env, providers, { ...input, session: await session(env, providers, input) }),
  applyRefresh: async (input: AccountInput & { messageId: string; entries: Parameters<typeof applyEventRefresh>[2]['entries'] }) =>
    applyEventRefresh(env, providers, { ...input, session: await session(env, providers, input) }),
});

/** Draft Rule Preview: the Rule Runs operation that proves a Draft Schema Rule against one message. */
export const ruleRunPreviews = (env: Bindings, providers: Providers) => ({
  previewDraft: async (input: AccountInput & { messageId: string; ruleId: string }) =>
    previewDraftRule(env, providers, { ...input, session: await session(env, providers, input) }),
  startDraft: async (input: AccountInput & { messageId: string; ruleId: string; ruleRevision: number; extraction: MailExtraction }) =>
    startDraftRuleRun(env, providers, { ...input, session: await session(env, providers, input) }),
});
