import { createAutomation } from '../automation';
import { expiresIn } from '../clock';
import { decrypt, encrypt, type CipherEnvelope } from '../cryptography';
import type { EventDetails, MailExtraction, TaskDetails } from '../event-details';
import type { Providers } from '../providers';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import { createAccountStore } from '../storage/account-store';
import { accountRoute, created, type AccountRequest } from './account';

const MAIL_TEST_WINDOW_MS = 15 * 60 * 1_000;
const MAIL_TEST_TOKEN_LIMIT = 60_000;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;

const mailTestContext = (accountId: string): string => `mail-test-preview:${accountId}`;
const mailTestRefreshContext = (accountId: string): string => `mail-test-refresh:${accountId}`;

interface MailTestConfirmation {
  purpose: 'mailbox_test' | 'draft_rule_preview';
  messageId: string;
  ruleId: string;
  ruleRevision: number;
  extraction: MailExtraction;
  expiresAt: string;
}

const isEventDetails = (value: unknown): value is EventDetails => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<EventDetails>;
  return typeof event.title === 'string'
    && typeof event.startsAt === 'string'
    && typeof event.endsAt === 'string'
    && typeof event.timeZone === 'string'
    && typeof event.location === 'string'
    && typeof event.description === 'string'
    && typeof event.summary === 'string'
    && Number.isFinite(Date.parse(event.startsAt))
    && Number.isFinite(Date.parse(event.endsAt))
    && Date.parse(event.startsAt) < Date.parse(event.endsAt);
};

const isTaskDetails = (value: unknown): value is TaskDetails => {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskDetails>;
  return typeof task.title === 'string' && Boolean(task.title.trim())
    && typeof task.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(task.deadline)
    && typeof task.assigneeContactId === 'string' && Boolean(task.assigneeContactId.trim())
    && typeof task.description === 'string' && Boolean(task.description.trim());
};

const isMailExtraction = (value: unknown): value is MailExtraction => {
  if (!value || typeof value !== 'object') return false;
  const extraction = value as Partial<MailExtraction>;
  return typeof extraction.summary === 'string' && Boolean(extraction.summary.trim()) && extraction.summary.length <= 2_000
    && Array.isArray(extraction.events) && extraction.events.length > 0 && extraction.events.every(isEventDetails)
    && Array.isArray(extraction.tasks) && extraction.tasks.every(isTaskDetails)
    && Array.isArray(extraction.warnings);
};

/** One approved Event Refresh row: the Scheduled Event to rewrite, pinned server-side. */
interface MailTestRefreshEntry {
  candidateIndex: number;
  googleEventId: string | null;
  etag: string | null;
  candidate: EventDetails;
}

interface MailTestRefreshConfirmation {
  messageId: string;
  entries: MailTestRefreshEntry[];
  expiresAt: string;
}

const isRefreshEntry = (value: unknown): value is MailTestRefreshEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MailTestRefreshEntry>;
  return typeof entry.candidateIndex === 'number' && Number.isInteger(entry.candidateIndex)
    && (entry.googleEventId === null || typeof entry.googleEventId === 'string')
    && (entry.etag === null || typeof entry.etag === 'string')
    && isEventDetails(entry.candidate);
};

const isRefreshConfirmation = (value: unknown): value is MailTestRefreshConfirmation => {
  if (!value || typeof value !== 'object') return false;
  const confirmation = value as Partial<MailTestRefreshConfirmation>;
  return typeof confirmation.messageId === 'string'
    && Array.isArray(confirmation.entries) && confirmation.entries.every(isRefreshEntry)
    && typeof confirmation.expiresAt === 'string';
};

type TokenRequest = AccountRequest<{ confirmationToken?: string }>;

const messageIdOf = (request: AccountRequest<unknown>): string => {
  const messageId = request.params.messageId ?? '';
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw invalid('Gmail メッセージ ID が不正です。');
  return messageId;
};

const presentedToken = (request: TokenRequest, hint: string): string => {
  const token = request.body.confirmationToken;
  if (!token || token.length > MAIL_TEST_TOKEN_LIMIT) throw invalid(`確認用トークンがありません。先に${hint}してください。`);
  return token;
};

const sealed = async (request: AccountRequest<unknown>, value: unknown, context: string): Promise<string> =>
  JSON.stringify(await encrypt(JSON.stringify(value), await request.key(), context));

const unsealed = async (request: AccountRequest<unknown>, token: string, context: string): Promise<unknown> =>
  JSON.parse(await decrypt(JSON.parse(token) as CipherEnvelope, await request.key(), context));

/** Reads the confirmed extraction back out of a Mailbox Test preview token, or refuses a stale one. */
const confirmedExtraction = async (request: TokenRequest, purpose: MailTestConfirmation['purpose']): Promise<MailTestConfirmation> => {
  const token = presentedToken(request, 'AI 抽出を実行');
  const confirmation = await unsealed(request, token, mailTestContext(request.accountId)) as Partial<MailTestConfirmation>;
  if (confirmation.purpose !== purpose || typeof confirmation.messageId !== 'string'
    || typeof confirmation.ruleId !== 'string' || typeof confirmation.ruleRevision !== 'number'
    || !isMailExtraction(confirmation.extraction)
    || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) {
    throw conflict('プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。');
  }
  return confirmation as MailTestConfirmation;
};

const previewResponse = async (
  request: AccountRequest<unknown>,
  purpose: MailTestConfirmation['purpose'],
  preview: { source: { id: string; subject: string; sender: string }; rule: { id: string; revision: number }; extraction: MailExtraction },
) => {
  const confirmation: MailTestConfirmation = {
    purpose,
    messageId: preview.source.id,
    ruleId: preview.rule.id,
    ruleRevision: preview.rule.revision,
    extraction: preview.extraction,
    expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
  };
  return {
    id: preview.source.id,
    subject: preview.source.subject,
    sender: preview.source.sender,
    selectedRule: { id: preview.rule.id, revision: preview.rule.revision },
    ...preview.extraction,
    confirmationToken: await sealed(request, confirmation, mailTestContext(request.accountId)),
    expiresAt: confirmation.expiresAt,
  };
};

/**
 * The Mailbox Test (a real Gmail message run through the Primary Rule, then
 * approved into Calendar), the Draft Rule Preview, and the Event Refresh.
 */
export const mailboxRoutes = (providers: Providers) => {
  const routes = resource();
  const automation = (request: AccountRequest<unknown>) => createAutomation(request.env, providers);

  routes.post('/organizations/:accountId/mail-tests/search', accountRoute<{ subject?: string }>(async (request) => {
    const subject = request.body.subject?.trim() ?? '';
    if (!subject || subject.length > 300) throw invalid('件名は 1〜300 文字で入力してください。');
    const inbox = await createAccountStore(request.db).currentAutomation();
    if (!inbox) throw notFound('Automation Inbox が見つかりません。');
    return {
      accountEmail: inbox.email,
      messages: await automation(request).mailboxTest.search({ accountId: request.accountId, database: request.database, subject }),
    };
  }));

  /** Returns the exact, redacted OpenAI-compatible payload without calling the AI API. */
  routes.post('/organizations/:accountId/mail-tests/:messageId/ai-request', accountRoute(async (request) => {
    const messageId = messageIdOf(request);
    const mailbox = automation(request).mailboxTest;
    const source = await mailbox.readSource({ accountId: request.accountId, database: request.database, messageId });
    const aiRequest = await mailbox.previewAiRequest({
      database: request.database,
      source: source.source,
      attachments: source.attachments,
      ...(source.receivedAt === undefined ? {} : { receivedAt: source.receivedAt }),
    });
    return { id: source.id, subject: source.subject, sender: source.sender, request: aiRequest };
  }));

  /** Draft Rule Preview is a Rule Runs concern, separate from the permanent Mailbox Test. */
  routes.post('/organizations/:accountId/mail-tests/:messageId/draft-preview', accountRoute<{ ruleId?: string }>(async (request) => {
    const messageId = messageIdOf(request);
    if (!request.body.ruleId) throw invalid('Draft Schema Rule を選択してください。');
    const preview = await automation(request).ruleRuns.previewDraft({
      accountId: request.accountId,
      database: request.database,
      messageId,
      ruleId: request.body.ruleId,
    });
    return previewResponse(request, 'draft_rule_preview', preview);
  }));

  routes.post('/organizations/:accountId/mail-tests/:messageId/preview', accountRoute(async (request) => {
    const messageId = messageIdOf(request);
    const preview = await automation(request).mailboxTest.preview({ accountId: request.accountId, database: request.database, messageId });
    return previewResponse(request, 'mailbox_test', preview);
  }));

  routes.post('/organizations/:accountId/mail-tests/calendar', accountRoute<{ confirmationToken?: string }>(async (request) => {
    const confirmation = await confirmedExtraction(request, 'mailbox_test');
    return created(await automation(request).mailboxTest.createCalendarEvents({
      accountId: request.accountId,
      database: request.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    }));
  }));

  routes.post('/organizations/:accountId/mail-tests/rule-run', accountRoute<{ confirmationToken?: string; ruleId?: string }>(async (request) => {
    if (!request.body.ruleId) throw invalid('Draft Schema Rule を選択してください。');
    const confirmation = await confirmedExtraction(request, 'draft_rule_preview');
    if (confirmation.ruleId !== request.body.ruleId) throw conflict('確認した Rule Revision と異なります。');
    return created(await automation(request).ruleRuns.startDraft({
      accountId: request.accountId,
      database: request.database,
      ruleId: request.body.ruleId,
      ruleRevision: confirmation.ruleRevision,
      messageId: confirmation.messageId,
      extraction: confirmation.extraction,
    }));
  }));

  const confirmedForMessage = async (request: TokenRequest): Promise<MailTestConfirmation> => {
    const confirmation = await confirmedExtraction(request, 'mailbox_test');
    if (confirmation.messageId !== request.params.messageId) throw conflict('確認用トークンが別のメールのものです。');
    return confirmation;
  };

  /** Prepares the correspondence request against the Scheduled Events this message already produced. */
  routes.post('/organizations/:accountId/mail-tests/:messageId/refresh-request', accountRoute<{ confirmationToken?: string }>(async (request) => {
    const confirmation = await confirmedForMessage(request);
    return automation(request).mailboxTest.previewRefreshRequest({
      accountId: request.accountId,
      database: request.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    });
  }));

  /** Runs the correspondence decision and returns the plan an AccountIdentity approves. */
  routes.post('/organizations/:accountId/mail-tests/:messageId/refresh-plan', accountRoute<{ confirmationToken?: string }>(async (request) => {
    const confirmation = await confirmedForMessage(request);
    const plan = await automation(request).mailboxTest.planRefresh({
      accountId: request.accountId,
      database: request.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    });
    const approvable: MailTestRefreshConfirmation = {
      messageId: confirmation.messageId,
      entries: plan.entries.map((entry) => ({
        candidateIndex: entry.candidateIndex,
        googleEventId: entry.target?.id ?? null,
        etag: entry.target?.etag ?? null,
        candidate: entry.candidate,
      })),
      expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
    };
    return {
      entries: plan.entries.map((entry) => ({
        candidateIndex: entry.candidateIndex,
        candidate: entry.candidate,
        target: entry.target,
        changedFields: entry.changedFields,
        desired: plan.desired[entry.candidateIndex] ?? null,
      })),
      unmatched: plan.unmatched,
      outOfWindow: plan.outOfWindow,
      pendingAttachments: plan.pendingAttachments,
      confirmationToken: await sealed(request, approvable, mailTestRefreshContext(request.accountId)),
      expiresAt: approvable.expiresAt,
    };
  }));

  /** Applies the approved Event Refresh, and re-offers anything the Calendar changed underneath it. */
  routes.post('/organizations/:accountId/mail-tests/refresh', accountRoute<{ confirmationToken?: string; candidateIndexes?: unknown }>(async (request) => {
    const token = presentedToken(request, '既存予定と照合');
    const selected = Array.isArray(request.body.candidateIndexes) && request.body.candidateIndexes.every((value) => typeof value === 'number')
      ? new Set(request.body.candidateIndexes as number[])
      : null;
    if (!selected?.size) throw invalid('更新する予定を選択してください。');
    const confirmation = await unsealed(request, token, mailTestRefreshContext(request.accountId));
    if (!isRefreshConfirmation(confirmation) || Date.parse(confirmation.expiresAt) <= Date.now()) {
      throw conflict('照合結果の有効期限が切れました。もう一度既存予定と照合してください。');
    }
    const entries = confirmation.entries.filter((entry) => selected.has(entry.candidateIndex));
    if (!entries.length) throw conflict('選択された予定が照合結果に含まれていません。');
    const outcome = await automation(request).mailboxTest.applyRefresh({
      accountId: request.accountId,
      database: request.database,
      messageId: confirmation.messageId,
      entries: entries.map((entry) => ({ googleEventId: entry.googleEventId, etag: entry.etag, candidate: entry.candidate })),
    });
    if (!outcome.conflicts.length) return { ...outcome, confirmationToken: null, expiresAt: null };
    const indexOf = new Map(entries.map((entry) => [entry.candidate.title + entry.candidate.startsAt, entry.candidateIndex]));
    const retry: MailTestRefreshConfirmation = {
      messageId: confirmation.messageId,
      entries: outcome.conflicts.map((entry) => ({
        candidateIndex: indexOf.get(entry.candidate.title + entry.candidate.startsAt) ?? 0,
        googleEventId: entry.googleEventId,
        etag: entry.etag,
        candidate: entry.candidate,
      })),
      expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
    };
    return {
      ...outcome,
      conflicts: outcome.conflicts.map((entry) => ({
        ...entry,
        candidateIndex: indexOf.get(entry.candidate.title + entry.candidate.startsAt) ?? 0,
      })),
      confirmationToken: await sealed(request, retry, mailTestRefreshContext(request.accountId)),
      expiresAt: retry.expiresAt,
    };
  }));

  return routes;
};
