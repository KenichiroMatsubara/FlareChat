import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, max, ne } from 'drizzle-orm';

import { canUpdateAttendance, discoveredLineDestinations, displayLineDestinationId, verifyLineWebhookSignature } from '@mail/domain';

import { agentWritePortForApproval, createAutomation, LEGACY_AI_BASE_URL } from './automation';
import { decrypt, encrypt } from './cryptography';
import { randomToken } from './encoding';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt } from './recovery-receipts';
import { exportMemberCsv, previewMemberCsv } from './roster';
import { failure, json } from './response';
import { entryRoutes, oauthRoutes } from './routes/entry';
import { automationRoutes } from './routes/automation';
import { portalRoutes } from './routes/portal';
import { createRequestContext } from './routes/request-context';
import { typedListRoutes } from './routes/typed-lists';
import type { Bindings, ConnectionRow, SessionRow } from './types';
import type { CipherEnvelope } from './cryptography';
import { openAiChatCompletionsUrl, type EventDetails, type MailExtraction, type TaskDetails } from './event-details';
import { approveProposedAction, expireProposedActions, proposedActionsForRun, readAgentRunTranscript, rejectProposedAction } from './agent-runs';
import { createTaskWorkflow } from './tasks';
import { applyPreset, availablePresets, PresetConfigurationConflictError } from './presets';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { createOrganizationStore } from './storage/organization-store';
import { admins, identities, organizations, recoveryRequests } from './storage/control-schema';
import {
  agentRuleRevisions,
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRules,
  agentRuns,
  attendance,
  automationWarnings,
  connections as organizationConnections,
  deliveries as organizationDeliveries,
  eventOverrides,
  eventRecipients,
  events as organizationEvents,
  exceptions as organizationExceptions,
  googleConnections,
  jobs as organizationJobs,
  lineDestinations,
  listItems,
  lists as organizationLists,
  memberLineDestinations,
  memberLinkTokens,
  members,
  portalInvitations,
  ruleRevisions,
  rulePermittedLineLists,
  rulePermittedRecipientLists,
  rules as organizationRules,
  operationalTaskRoles,
  promptRevisions,
  prompts,
  proposedActions,
  taskRoleAssignments,
} from './storage/organization-schema';

const RECIPIENT_LINK_WINDOW_MS = 15 * 60 * 1_000;
const LINE_DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
type OrganizationCredential = Record<string, string>;

interface LineConnectionInput {
  channelAccessToken?: string;
  channelSecret?: string;
}

interface AiConnectionInput {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface LineProfileResponse {
  displayName?: string;
}

interface LineWebhookPayload {
  events?: Array<{
    source?: {
      type?: string;
      userId?: string;
      groupId?: string;
      roomId?: string;
    };
  }>;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));
app.route('/api', entryRoutes);
app.route('/api', automationRoutes);
app.route('/api', typedListRoutes);
app.route('/api', portalRoutes);
app.route('/', oauthRoutes);

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const organizationForRequest = (request: Request, env: Bindings, organizationId: string) =>
  createRequestContext(request, env).organization(organizationId);

const organizationKeyForRequest = (env: Bindings, organizationId: string) =>
  createRequestContext(new Request('https://request-context.invalid'), env).organizationKey(organizationId);

const activeOrganizationDatabase = (env: Bindings, organizationId: string) =>
  createRequestContext(new Request('https://request-context.invalid'), env).activeOrganizationDatabase(organizationId);

const mailTestContext = (organizationId: string): string => `mail-test-preview:${organizationId}`;
const MAIL_TEST_WINDOW_MS = 15 * 60 * 1_000;

app.get('/api/presets', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
  return json(context, availablePresets().map(({ id, name, description }) => ({ id, name, description })));
});

app.post('/api/organizations/:organizationId/presets/:presetId/apply', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, 'Organization database is not available.', 503);
    const input = await context.req.json<{ conflictPolicy?: unknown }>();
    if (input.conflictPolicy !== undefined && input.conflictPolicy !== 'duplicate') return failure(context, 'Unsupported Preset conflict policy.');
    const applied = await applyPreset(
      drizzleOrganizationDatabase(access.database),
      access.organization.id,
      context.req.param('presetId'),
      input.conflictPolicy === 'duplicate' ? { conflictPolicy: 'duplicate' } : {},
    );
    return json(context, applied, 201);
  } catch (error) {
    if (error instanceof PresetConfigurationConflictError) {
      return context.json({ error: { code: 'preset_configuration_conflict', message: error.message } }, 409);
    }
    const message = error instanceof Error ? error.message : 'Preset could not be applied.';
    return failure(context, message, message === 'Preset was not found.' ? 404 : 409);
  }
});

interface MailTestConfirmation {
  messageId: string;
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
    && typeof task.assigneeRoleId === 'string' && Boolean(task.assigneeRoleId.trim())
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

const mailTestRefreshContext = (organizationId: string): string => `mail-test-refresh:${organizationId}`;
const MAIL_TEST_TOKEN_LIMIT = 60_000;

const refreshToken = async (
  env: Bindings,
  organizationId: string,
  confirmation: MailTestRefreshConfirmation,
): Promise<string> => JSON.stringify(await encrypt(
  JSON.stringify(confirmation),
  await organizationKeyForRequest(env, organizationId),
  mailTestRefreshContext(organizationId),
));

const connectionContext = (organizationId: string, kind: 'line' | 'ai'): string => `organization-connection:${organizationId}:${kind}`;
const lineWebhookUrl = (appUrl: string, organizationId: string): string =>
  `${appUrl.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(organizationId)}/line/webhook`;

const lineDestinationDisplayName = async (
  credential: OrganizationCredential,
  destination: { destinationId: string; kind: 'user' | 'group' | 'room' },
  payload: LineWebhookPayload,
): Promise<string> => {
  if (destination.kind !== 'user' || !credential.channelAccessToken) return '';
  try {
    const source = payload.events?.find((event) => event.source?.userId === destination.destinationId)?.source;
    const profilePath = source?.type === 'group' && source.groupId
      ? `group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(destination.destinationId)}`
      : source?.type === 'room' && source.roomId
        ? `room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(destination.destinationId)}`
        : `profile/${encodeURIComponent(destination.destinationId)}`;
    const response = await fetch(
      `https://api.line.me/v2/bot/${profilePath}`,
      { headers: { Authorization: `Bearer ${credential.channelAccessToken}` } },
    );
    if (!response.ok) return '';
    const profile = await response.json() as LineProfileResponse;
    return profile.displayName?.trim() ?? '';
  } catch {
    return '';
  }
};

const connectionCredential = async (
  row: ConnectionRow | null,
  key: CryptoKey,
  organizationId: string,
  kind: 'line' | 'ai',
): Promise<OrganizationCredential> => {
  if (!row) return {};
  return JSON.parse(await decrypt(JSON.parse(row.credential), key, connectionContext(organizationId, kind))) as OrganizationCredential;
};

const saveConnectionCredential = async (input: {
  database: D1Database;
  existing: ConnectionRow | undefined;
  organizationKey: CryptoKey;
  organizationId: string;
  kind: 'line' | 'ai';
  label: string;
  credential: OrganizationCredential;
}): Promise<void> => {
  const db = drizzleOrganizationDatabase(input.database);
  const timestamp = now();
  const envelope = await encrypt(
    JSON.stringify(input.credential),
    input.organizationKey,
    connectionContext(input.organizationId, input.kind),
  );
  const storedCredential = JSON.stringify(envelope);
  if (input.existing) {
    await db.update(organizationConnections).set({
      label: input.label,
      credential: storedCredential,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(organizationConnections.id, input.existing.id)).run();
    return;
  }
  await db.insert(organizationConnections).values({
    id: crypto.randomUUID(),
    kind: input.kind,
    label: input.label,
    credential: storedCredential,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
};

const connectionView = (line: OrganizationCredential, ai: OrganizationCredential) => ({
  line: {
    channelAccessTokenConfigured: Boolean(line.channelAccessToken),
    channelSecretConfigured: Boolean(line.channelSecret),
  },
  ai: {
    apiKeyConfigured: Boolean(ai.apiKey),
    model: ai.model ?? '',
    baseUrl: ai.baseUrl ?? (ai.apiKey ? LEGACY_AI_BASE_URL : ''),
  },
});

export const generatedText = (response: OpenAiCompatibleResponse): string =>
  response.choices?.[0]?.message?.content?.trim() ?? '';

const normalizedAiBaseUrl = (value: string | undefined): string | null => {
  try {
    const url = new URL(value?.trim() ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return null;
  }
};

app.get('/api/organizations/:organizationId/connections', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationConnections)
      .where(and(inArray(organizationConnections.kind, ['line', 'ai']), eq(organizationConnections.status, 'active'))).all();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const line = rows.find((row) => row.kind === 'line');
    const ai = rows.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(line ?? null, organizationKey, organizationId, 'line'),
      connectionCredential(ai ?? null, organizationKey, organizationId, 'ai'),
    ]);
    const view = connectionView(lineCredential, aiCredential);
    return json(context, {
      organizationId,
      organizationName: access.organization.name,
      line: { ...view.line, webhookUrl: lineWebhookUrl(context.env.APP_URL, organizationId) },
      ai: view.ai,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を取得できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:organizationId/connections/line', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。LINE接続は保存されていません。', 503);
    const db = drizzleOrganizationDatabase(access.database);
    const input = await context.req.json<LineConnectionInput>();
    const existing = await db.select().from(organizationConnections)
      .where(and(eq(organizationConnections.kind, 'line'), eq(organizationConnections.status, 'active'))).limit(1).get();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const current = await connectionCredential(existing ?? null, organizationKey, organizationId, 'line');
    const next: OrganizationCredential = { ...current, ...input };
    if (!next.channelAccessToken || !next.channelSecret) return failure(context, 'LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    await saveConnectionCredential({ database: access.database, existing, organizationKey, organizationId, kind: 'line', label: 'LINE Messaging API', credential: next });
    return json(context, {
      ...connectionView(next, {}).line,
      webhookUrl: lineWebhookUrl(context.env.APP_URL, organizationId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LINE接続を保存できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:organizationId/connections/ai', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。AI接続は保存されていません。', 503);
    const db = drizzleOrganizationDatabase(access.database);
    const input = await context.req.json<AiConnectionInput>();
    const existing = await db.select().from(organizationConnections)
      .where(and(eq(organizationConnections.kind, 'ai'), eq(organizationConnections.status, 'active'))).limit(1).get();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const current = await connectionCredential(existing ?? null, organizationKey, organizationId, 'ai');
    const next: OrganizationCredential = { ...current, ...input };
    const baseUrl = normalizedAiBaseUrl(next.baseUrl);
    const model = next.model?.trim();
    if (!next.apiKey || !model || !baseUrl) return failure(context, 'OpenAI 互換 API の Base URL、model、API キーを入力してください。');
    if (model.length > 200) return failure(context, 'model は 200 文字以内で入力してください。');
    next.provider = 'OpenAI-compatible API';
    next.model = model;
    next.baseUrl = baseUrl;
    await saveConnectionCredential({ database: access.database, existing, organizationKey, organizationId, kind: 'ai', label: 'OpenAI 互換 API', credential: next });
    return json(context, connectionView({}, next).ai);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI接続を保存できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.post('/api/organizations/:organizationId/connections/ai/test', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const input = await context.req.json<{ prompt?: string }>();
    const prompt = input.prompt?.trim() ?? '';
    if (!prompt || prompt.length > 10_000) return failure(context, 'テスト用の質問は 1〜10,000 文字で入力してください。');
    const existing = await drizzleOrganizationDatabase(access.database).select().from(organizationConnections)
      .where(and(eq(organizationConnections.kind, 'ai'), eq(organizationConnections.status, 'active'))).limit(1).get();
    if (!existing) return failure(context, 'OpenAI 互換 API を設定してください。', 409);
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const credential = await connectionCredential(existing, organizationKey, organizationId, 'ai');
    const model = credential.model?.trim();
    const baseUrl = normalizedAiBaseUrl(credential.baseUrl || LEGACY_AI_BASE_URL);
    if (!credential.apiKey || !model || !baseUrl) return failure(context, 'OpenAI 互換 API を設定してください。', 409);
    const response = await fetch(openAiChatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await response.json() as OpenAiCompatibleResponse;
    if (!response.ok) throw new Error(body.error?.message ?? 'OpenAI 互換 API が応答しませんでした。');
    const text = generatedText(body);
    if (!text) throw new Error('OpenAI 互換 API からテキスト応答を受け取れませんでした。');
    return json(context, { text, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI 互換 API の接続テストに失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/search', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ subject?: string }>();
    const subject = input.subject?.trim() ?? '';
    if (!subject || subject.length > 300) return failure(context, '件名は 1〜300 文字で入力してください。');
    const automation = await createOrganizationStore(drizzleOrganizationDatabase(access.database)).currentAutomation();
    if (!automation) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { accountEmail: automation.email, messages: await createAutomation(context.env).mailboxTest.search({ organizationId, database: access.database, subject }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gmail の検索に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Returns the exact, redacted OpenAI-compatible payload without calling the AI API. */
app.post('/api/organizations/:organizationId/mail-tests/:messageId/ai-request', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await createAutomation(context.env).mailboxTest.readSource({ organizationId, database: access.database, messageId });
    const request = await createAutomation(context.env).mailboxTest.previewAiRequest({
      database: access.database,
      source: source.source,
      attachments: source.attachments,
      ...(source.receivedAt === undefined ? {} : { receivedAt: source.receivedAt }),
    });
    return json(context, { id: source.id, subject: source.subject, sender: source.sender, request });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 送信内容の準備に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/:messageId/preview', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await createAutomation(context.env).mailboxTest.readSource({ organizationId, database: access.database, messageId });
    const extraction = await createAutomation(context.env).mailboxTest.extractPackage({
      organizationId,
      database: access.database,
      source: source.source,
      attachments: source.attachments,
      ...(source.receivedAt === undefined ? {} : { receivedAt: source.receivedAt }),
    });
    if (!extraction) return failure(context, 'メールから安全な予定を抽出できませんでした。日付・開始時刻・終了時刻を確認してください。');
    const confirmation: MailTestConfirmation = { messageId, extraction, expiresAt: expiresIn(MAIL_TEST_WINDOW_MS) };
    const token = JSON.stringify(await encrypt(JSON.stringify(confirmation), await organizationKeyForRequest(context.env, organizationId), mailTestContext(organizationId)));
    return json(context, { id: source.id, subject: source.subject, sender: source.sender, ...extraction, confirmationToken: token, expiresAt: confirmation.expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI による予定の抽出に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/calendar', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > 10_000) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = JSON.parse(await decrypt(JSON.parse(input.confirmationToken) as CipherEnvelope, await organizationKeyForRequest(context.env, organizationId), mailTestContext(organizationId))) as Partial<MailTestConfirmation>;
    if (typeof confirmation.messageId !== 'string' || !isMailExtraction(confirmation.extraction) || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) {
      return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    }
    return json(context, await createAutomation(context.env).mailboxTest.createCalendarEvents({
      organizationId,
      database: access.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    }), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google Calendar へのテスト予定作成に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Reads the confirmed extraction back out of a Mailbox Test preview token. */
const confirmedExtraction = async (
  env: Bindings,
  organizationId: string,
  token: string,
): Promise<MailTestConfirmation | null> => {
  const confirmation = JSON.parse(await decrypt(
    JSON.parse(token) as CipherEnvelope,
    await organizationKeyForRequest(env, organizationId),
    mailTestContext(organizationId),
  )) as Partial<MailTestConfirmation>;
  if (typeof confirmation.messageId !== 'string' || !isMailExtraction(confirmation.extraction)
    || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) return null;
  return confirmation as MailTestConfirmation;
};

/** Prepares the correspondence request against the Scheduled Events this message already produced. */
app.post('/api/organizations/:organizationId/mail-tests/:messageId/refresh-request', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = await confirmedExtraction(context.env, organizationId, input.confirmationToken);
    if (!confirmation) return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    if (confirmation.messageId !== context.req.param('messageId')) return failure(context, '確認用トークンが別のメールのものです。', 409);
    return json(context, await createAutomation(context.env).mailboxTest.previewRefreshRequest({
      organizationId,
      database: access.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定の照合準備に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Runs the correspondence decision and returns the plan an Admin approves. */
app.post('/api/organizations/:organizationId/mail-tests/:messageId/refresh-plan', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = await confirmedExtraction(context.env, organizationId, input.confirmationToken);
    if (!confirmation) return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    if (confirmation.messageId !== context.req.param('messageId')) return failure(context, '確認用トークンが別のメールのものです。', 409);
    const plan = await createAutomation(context.env).mailboxTest.planRefresh({
      organizationId,
      database: access.database,
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
    return json(context, {
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
      confirmationToken: await refreshToken(context.env, organizationId, approvable),
      expiresAt: approvable.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定との照合に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Applies the approved Event Refresh, and re-offers anything the Calendar changed underneath it. */
app.post('/api/organizations/:organizationId/mail-tests/refresh', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string; candidateIndexes?: unknown }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に既存予定と照合してください。');
    const selected = Array.isArray(input.candidateIndexes) && input.candidateIndexes.every((value) => typeof value === 'number')
      ? new Set(input.candidateIndexes as number[])
      : null;
    if (!selected?.size) return failure(context, '更新する予定を選択してください。');
    const confirmation = JSON.parse(await decrypt(
      JSON.parse(input.confirmationToken) as CipherEnvelope,
      await organizationKeyForRequest(context.env, organizationId),
      mailTestRefreshContext(organizationId),
    )) as unknown;
    if (!isRefreshConfirmation(confirmation) || Date.parse(confirmation.expiresAt) <= Date.now()) {
      return failure(context, '照合結果の有効期限が切れました。もう一度既存予定と照合してください。', 409);
    }
    const entries = confirmation.entries.filter((entry) => selected.has(entry.candidateIndex));
    if (!entries.length) return failure(context, '選択された予定が照合結果に含まれていません。', 409);
    const outcome = await createAutomation(context.env).mailboxTest.applyRefresh({
      organizationId,
      database: access.database,
      messageId: confirmation.messageId,
      entries: entries.map((entry) => ({ googleEventId: entry.googleEventId, etag: entry.etag, candidate: entry.candidate })),
    });
    if (!outcome.conflicts.length) return json(context, { ...outcome, confirmationToken: null, expiresAt: null });
    const indexOf = new Map(entries.map((entry) => [entry.candidate.title + entry.candidate.startsAt, entry.candidateIndex]));
    const retry: MailTestRefreshConfirmation = {
      messageId: confirmation.messageId,
      entries: outcome.conflicts.map((conflict) => ({
        candidateIndex: indexOf.get(conflict.candidate.title + conflict.candidate.startsAt) ?? 0,
        googleEventId: conflict.googleEventId,
        etag: conflict.etag,
        candidate: conflict.candidate,
      })),
      expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
    };
    return json(context, {
      ...outcome,
      conflicts: outcome.conflicts.map((conflict) => ({
        ...conflict,
        candidateIndex: indexOf.get(conflict.candidate.title + conflict.candidate.startsAt) ?? 0,
      })),
      confirmationToken: await refreshToken(context.env, organizationId, retry),
      expiresAt: retry.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定の更新に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.get('/api/organizations/:organizationId/lists', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const database = drizzleOrganizationDatabase(access.database);
    const rows = await database.select().from(organizationLists).orderBy(asc(organizationLists.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed Lists could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/lists', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ kind?: string; name?: string; description?: string }>();
    const kind = input.kind?.trim() as 'source' | 'recipient' | 'line' | undefined;
    const name = input.name?.trim();
    if (!kind || !['source', 'recipient', 'line'].includes(kind)) return failure(context, 'Unsupported Typed List kind.');
    if (!name) return failure(context, 'Typed List name is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const description = input.description?.trim() ?? '';
    await drizzleOrganizationDatabase(access.database).insert(organizationLists).values({
      id,
      organizationId: access.organization.id,
      kind,
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return json(context, {
      id,
      organizationId: access.organization.id,
      kind,
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed List could not be created.', 409);
  }
});

app.post('/api/organizations/:organizationId/lists/:listId/items', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ value?: string; label?: string }>();
    const value = input.value?.trim();
    if (!value) return failure(context, 'List Item value is required.');
    const id = crypto.randomUUID();
    await drizzleOrganizationDatabase(access.database).insert(listItems).values({
      id,
      listId: context.req.param('listId'),
      value,
      label: input.label?.trim() ?? '',
      enabled: true,
    }).run();
    return json(context, { id, listId: context.req.param('listId'), value, label: input.label?.trim() ?? '', enabled: true }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/lists/:listId/items/:itemId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const updated = await drizzleOrganizationDatabase(access.database).update(listItems)
      .set({ enabled: input.enabled })
      .where(and(eq(listItems.id, context.req.param('itemId')), eq(listItems.listId, context.req.param('listId'))))
      .returning({ id: listItems.id }).get();
    if (!updated) return failure(context, 'List Item was not found.', 404);
    return json(context, { id: context.req.param('itemId'), enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/prompts', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(prompts)
      .orderBy(asc(prompts.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      instructions: row.instructions,
      revision: row.currentRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompts could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/prompts', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; instructions?: string }>();
    const name = input.name?.trim() ?? '';
    const instructions = input.instructions?.trim() ?? '';
    if (!name || name.length > 100) return failure(context, 'A Prompt name of at most 100 characters is required.');
    if (!instructions || instructions.length > 100_000) return failure(context, 'Prompt instructions of at most 100000 characters are required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.insert(prompts).values({ id, organizationId: access.organization.id, name, instructions, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
      database.insert(promptRevisions).values({ promptId: id, revision: 1, instructions, createdAt: timestamp }),
    ]);
    return json(context, { id, organizationId: access.organization.id, name, instructions, revision: 1, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompt could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/prompts/:promptId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; instructions?: string }>();
    const name = input.name?.trim();
    const instructions = input.instructions?.trim();
    if (name === undefined && instructions === undefined) return failure(context, 'A Prompt name or instructions is required.');
    if (name !== undefined && (!name || name.length > 100)) return failure(context, 'A Prompt name of at most 100 characters is required.');
    if (instructions !== undefined && (!instructions || instructions.length > 100_000)) return failure(context, 'Prompt instructions of at most 100000 characters are required.');
    const database = drizzleOrganizationDatabase(access.database);
    const promptId = context.req.param('promptId');
    const existing = await database.select().from(prompts).where(eq(prompts.id, promptId)).get();
    if (!existing) return failure(context, 'Prompt was not found.', 404);
    const revision = instructions === undefined ? existing.currentRevision : existing.currentRevision + 1;
    const timestamp = now();
    await database.batch([
      database.update(prompts).set({ ...(name === undefined ? {} : { name }), ...(instructions === undefined ? {} : { instructions, currentRevision: revision }), updatedAt: timestamp }).where(eq(prompts.id, promptId)),
      ...(instructions === undefined ? [] : [database.insert(promptRevisions).values({ promptId, revision, instructions, createdAt: timestamp })]),
    ]);
    return json(context, { id: promptId, ...(name === undefined ? {} : { name }), ...(instructions === undefined ? {} : { instructions }), revision, updatedAt: timestamp });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompt could not be updated.', 409);
  }
});

app.delete('/api/organizations/:organizationId/prompts/:promptId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const promptId = context.req.param('promptId');
    const removed = await drizzleOrganizationDatabase(access.database).delete(prompts).where(eq(prompts.id, promptId))
      .returning({ id: prompts.id }).get();
    if (!removed) return failure(context, 'Prompt was not found.', 404);
    return json(context, { id: promptId, removed: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompt could not be deleted.', 409);
  }
});

const agentRuleView = (row: typeof agentRules.$inferSelect, permittedRecipientListIds: string[] = [], permittedLineListIds: string[] = []) => ({
  id: row.id,
  organizationId: row.organizationId,
  name: row.name,
  state: row.status,
  executionMode: row.executionMode,
  permittedRecipientListIds,
  permittedLineListIds,
  promptId: row.promptId,
  selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
  priority: row.priority,
  revision: row.currentRevision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

app.get('/api/organizations/:organizationId/agent-rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(agentRules)
      .orderBy(desc(agentRules.priority), asc(agentRules.name)).all();
    const database = drizzleOrganizationDatabase(access.database);
    const ids = rows.map(({ id }) => id);
    const [recipientReferences, lineReferences] = ids.length ? await Promise.all([
      database.select().from(agentRulePermittedRecipientLists).where(inArray(agentRulePermittedRecipientLists.agentRuleId, ids)).all(),
      database.select().from(agentRulePermittedLineLists).where(inArray(agentRulePermittedLineLists.agentRuleId, ids)).all(),
    ]) : [[], []];
    return json(context, rows.map((row) => agentRuleView(
      row,
      recipientReferences.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
      lineReferences.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
    )));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Agent Rules could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/agent-rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; promptId?: string; state?: string; executionMode?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    const name = input.name?.trim() ?? '';
    const promptId = input.promptId?.trim() ?? '';
    const state = input.state ?? 'active';
    if (!name || name.length > 100) return failure(context, 'An Agent Rule name of at most 100 characters is required.');
    if (!promptId) return failure(context, 'An Agent Rule Prompt is required.');
    if (!['active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Agent Rule State.');
    const executionMode = input.executionMode ?? 'approval';
    if (!['read_only', 'approval', 'unattended'].includes(executionMode)) return failure(context, 'Unsupported Agent Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const database = drizzleOrganizationDatabase(access.database);
    const prompt = await database.select({ id: prompts.id }).from(prompts).where(and(
      eq(prompts.id, promptId),
      eq(prompts.organizationId, access.organization.id),
    )).get();
    if (!prompt) return failure(context, 'Agent Rule Prompt was not found.', 409);
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const priority = Number.isInteger(input.priority) ? input.priority! : 0;
    const permittedRecipientListIds = [...new Set((input.permittedRecipientListIds ?? []) as string[])];
    const permittedLineListIds = [...new Set((input.permittedLineListIds ?? []) as string[])];
    const permittedListIds = [...permittedRecipientListIds, ...permittedLineListIds];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: organizationLists.id, kind: organizationLists.kind }).from(organizationLists).where(inArray(organizationLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Organization and have recipient kind.', 409);
      if (permittedLineListIds.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Organization and have line kind.', 409);
    }
    await database.batch([
      database.insert(agentRules).values({ id, organizationId: access.organization.id, name, status: state as 'active' | 'suspended' | 'archived', executionMode: executionMode as 'read_only' | 'approval' | 'unattended', promptId, selectionPolicy, priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
      database.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId: id, revision: 1, promptId, selectionPolicy, executionMode: executionMode as 'read_only' | 'approval' | 'unattended', permittedRecipientListIds: JSON.stringify(permittedRecipientListIds), permittedLineListIds: JSON.stringify(permittedLineListIds), createdAt: timestamp }),
      ...permittedRecipientListIds.map((listId) => database.insert(agentRulePermittedRecipientLists).values({ agentRuleId: id, listId })),
      ...permittedLineListIds.map((listId) => database.insert(agentRulePermittedLineLists).values({ agentRuleId: id, listId })),
    ]);
    return json(context, agentRuleView({ id, organizationId: access.organization.id, name, status: state as 'active' | 'suspended' | 'archived', executionMode: executionMode as 'read_only' | 'approval' | 'unattended', promptId, selectionPolicy, priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }, permittedRecipientListIds, permittedLineListIds), 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Agent Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/agent-rules/:agentRuleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; promptId?: string; state?: string; executionMode?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    if (input.state !== undefined && !['active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Agent Rule State.');
    if (input.executionMode !== undefined && !['read_only', 'approval', 'unattended'].includes(input.executionMode)) return failure(context, 'Unsupported Agent Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((listId) => typeof listId !== 'string' || !listId.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((listId) => typeof listId !== 'string' || !listId.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const name = input.name?.trim();
    const promptId = input.promptId?.trim();
    if (name !== undefined && (!name || name.length > 100)) return failure(context, 'An Agent Rule name of at most 100 characters is required.');
    if (input.promptId !== undefined && !promptId) return failure(context, 'An Agent Rule Prompt is required.');
    const database = drizzleOrganizationDatabase(access.database);
    const id = context.req.param('agentRuleId');
    const existing = await database.select().from(agentRules).where(eq(agentRules.id, id)).get();
    if (!existing) return failure(context, 'Agent Rule was not found.', 404);
    if (promptId) {
      const prompt = await database.select({ id: prompts.id }).from(prompts).where(and(eq(prompts.id, promptId), eq(prompts.organizationId, access.organization.id))).get();
      if (!prompt) return failure(context, 'Agent Rule Prompt was not found.', 409);
    }
    const permittedRecipientListIds = input.permittedRecipientListIds === undefined ? undefined : [...new Set(input.permittedRecipientListIds as string[])];
    const permittedLineListIds = input.permittedLineListIds === undefined ? undefined : [...new Set(input.permittedLineListIds as string[])];
    const permittedListIds = [...(permittedRecipientListIds ?? []), ...(permittedLineListIds ?? [])];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: organizationLists.id, kind: organizationLists.kind }).from(organizationLists).where(inArray(organizationLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds?.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Organization and have recipient kind.', 409);
      if (permittedLineListIds?.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Organization and have line kind.', 409);
    }
    const configurationChanged = promptId !== undefined || input.selectionPolicy !== undefined || input.executionMode !== undefined || permittedRecipientListIds !== undefined || permittedLineListIds !== undefined;
    const revision = configurationChanged ? existing.currentRevision + 1 : existing.currentRevision;
    const timestamp = now();
    const nextPromptId = promptId ?? existing.promptId;
    const nextSelectionPolicy = input.selectionPolicy === undefined ? existing.selectionPolicy : JSON.stringify(input.selectionPolicy);
    const [currentRecipientReferences, currentLineReferences] = await Promise.all([
      database.select({ listId: agentRulePermittedRecipientLists.listId }).from(agentRulePermittedRecipientLists).where(eq(agentRulePermittedRecipientLists.agentRuleId, id)).all(),
      database.select({ listId: agentRulePermittedLineLists.listId }).from(agentRulePermittedLineLists).where(eq(agentRulePermittedLineLists.agentRuleId, id)).all(),
    ]);
    const nextRecipientListIds = permittedRecipientListIds ?? currentRecipientReferences.map(({ listId }) => listId);
    const nextLineListIds = permittedLineListIds ?? currentLineReferences.map(({ listId }) => listId);
    const nextExecutionMode = (input.executionMode ?? existing.executionMode) as 'read_only' | 'approval' | 'unattended';
    await database.batch([
      database.update(agentRules).set({
        ...(name === undefined ? {} : { name }),
        ...(input.state === undefined ? {} : { status: input.state as 'active' | 'suspended' | 'archived' }),
        ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode as 'read_only' | 'approval' | 'unattended' }),
        ...(input.priority === undefined || !Number.isInteger(input.priority) ? {} : { priority: input.priority }),
        promptId: nextPromptId,
        selectionPolicy: nextSelectionPolicy,
        currentRevision: revision,
        updatedAt: timestamp,
      }).where(eq(agentRules.id, id)),
      ...(configurationChanged ? [database.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId: id, revision, promptId: nextPromptId, selectionPolicy: nextSelectionPolicy, executionMode: nextExecutionMode, permittedRecipientListIds: JSON.stringify(nextRecipientListIds), permittedLineListIds: JSON.stringify(nextLineListIds), createdAt: timestamp })] : []),
    ]);
    if (permittedRecipientListIds !== undefined) await database.batch([
      database.delete(agentRulePermittedRecipientLists).where(eq(agentRulePermittedRecipientLists.agentRuleId, id)),
      ...permittedRecipientListIds.map((listId) => database.insert(agentRulePermittedRecipientLists).values({ agentRuleId: id, listId })),
    ]);
    if (permittedLineListIds !== undefined) await database.batch([
      database.delete(agentRulePermittedLineLists).where(eq(agentRulePermittedLineLists.agentRuleId, id)),
      ...permittedLineListIds.map((listId) => database.insert(agentRulePermittedLineLists).values({ agentRuleId: id, listId })),
    ]);
    const updated = await database.select().from(agentRules).where(eq(agentRules.id, id)).get();
    const [recipientReferences, lineReferences] = await Promise.all([
      database.select({ listId: agentRulePermittedRecipientLists.listId }).from(agentRulePermittedRecipientLists).where(eq(agentRulePermittedRecipientLists.agentRuleId, id)).all(),
      database.select({ listId: agentRulePermittedLineLists.listId }).from(agentRulePermittedLineLists).where(eq(agentRulePermittedLineLists.agentRuleId, id)).all(),
    ]);
    return json(context, agentRuleView(updated!, recipientReferences.map(({ listId }) => listId), lineReferences.map(({ listId }) => listId)));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Agent Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/agent-runs', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      id: agentRuns.id,
      agentRuleId: agentRuns.agentRuleId,
      agentRuleRevision: agentRuns.agentRuleRevision,
      promptId: agentRuns.promptId,
      promptRevision: agentRuns.promptRevision,
      sourceMessageId: agentRuns.sourceMessageId,
      model: agentRuns.model,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
      outcome: agentRuns.outcome,
      toolCallCount: agentRuns.toolCallCount,
      tokens: agentRuns.tokens,
      expiresAt: agentRuns.expiresAt,
    }).from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(100).all();
    return json(context, rows);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Agent Rule runs could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/agent-runs/:runId/transcript', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const runId = context.req.param('runId');
    const run = await drizzleOrganizationDatabase(access.database).select({ id: agentRuns.id }).from(agentRuns)
      .where(eq(agentRuns.id, runId)).get();
    if (!run) return failure(context, 'Run Transcript was not found.', 404);
    const transcript = await readAgentRunTranscript({
      bucket: context.env.RECOVERY_RECEIPTS,
      organizationKey: await organizationKeyForRequest(context.env, access.organization.id),
      organizationId: access.organization.id,
      runId,
    });
    if (!transcript) return failure(context, 'Run Transcript was not found.', 404);
    return json(context, transcript);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Run Transcript could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/agent-runs/:runId/proposed-actions', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const runId = context.req.param('runId');
    const run = await drizzleOrganizationDatabase(access.database).select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!run) return failure(context, 'Agent Rule run was not found.', 404);
    await expireProposedActions(access.database);
    return json(context, await proposedActionsForRun(access.database, runId));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Proposed Actions could not be loaded.', 403);
  }
});

const proposedActionDecision = async (context: Context<{ Bindings: Bindings }>, decision: 'approve' | 'reject') => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId') ?? '');
    if (!access.database) throw new Error('Organization database is not available.');
    const actionId = context.req.param('actionId') ?? '';
    const action = await drizzleOrganizationDatabase(access.database).select().from(proposedActions).where(eq(proposedActions.id, actionId)).get();
    if (!action) return failure(context, 'Proposed Action was not found.', 404);
    if (decision === 'reject') return json(context, await rejectProposedAction(access.database, actionId, access.session.identity_id));
    const run = await drizzleOrganizationDatabase(access.database).select({ sourceMessageId: agentRuns.sourceMessageId }).from(agentRuns).where(eq(agentRuns.id, action.agentRunId)).get();
    if (!run) return failure(context, 'Agent Rule run was not found.', 404);
    const writes = await agentWritePortForApproval({ env: context.env, database: access.database, organizationId: access.organization.id, sourceMessageId: run.sourceMessageId, agentRuleId: action.agentRuleId });
    return json(context, await approveProposedAction({ database: access.database, actionId, actorIdentityId: access.session.identity_id, writes }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Proposed Action could not be decided.', 409);
  }
};

app.post('/api/organizations/:organizationId/proposed-actions/:actionId/approve', (context) => proposedActionDecision(context, 'approve'));
app.post('/api/organizations/:organizationId/proposed-actions/:actionId/reject', (context) => proposedActionDecision(context, 'reject'));

app.post('/api/organizations/:organizationId/agent-runs/:runId/proposed-actions/:decision', async (context) => {
  try {
    const decision = context.req.param('decision');
    if (decision !== 'approve' && decision !== 'reject') return failure(context, 'Unsupported Proposed Action decision.');
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const runId = context.req.param('runId');
    const run = await drizzleOrganizationDatabase(access.database).select({ sourceMessageId: agentRuns.sourceMessageId, agentRuleId: agentRuns.agentRuleId }).from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!run) return failure(context, 'Agent Rule run was not found.', 404);
    await expireProposedActions(access.database);
    const pending = (await proposedActionsForRun(access.database, runId)).filter((action) => action.status === 'pending');
    const writes = decision === 'approve' ? await agentWritePortForApproval({ env: context.env, database: access.database, organizationId: access.organization.id, sourceMessageId: run.sourceMessageId, agentRuleId: run.agentRuleId }) : null;
    const decided = [];
    for (const action of pending) {
      decided.push(decision === 'approve'
        ? await approveProposedAction({ database: access.database, actionId: action.id, actorIdentityId: access.session.identity_id, writes: writes! })
        : await rejectProposedAction(access.database, action.id, access.session.identity_id));
    }
    return json(context, decided);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Proposed Action batch could not be decided.', 409);
  }
});

app.get('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationRules)
      .orderBy(desc(organizationRules.priority), asc(organizationRules.name)).all();
    const ruleIds = rows.map(({ id }) => id);
    const database = drizzleOrganizationDatabase(access.database);
    const [recipientLists, lineLists] = ruleIds.length ? await Promise.all([
      database.select().from(rulePermittedRecipientLists)
        .where(inArray(rulePermittedRecipientLists.ruleId, ruleIds)).all(),
      database.select().from(rulePermittedLineLists)
        .where(inArray(rulePermittedLineLists.ruleId, ruleIds)).all(),
    ]) : [[], []];
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      state: row.status,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routingPolicy) as Record<string, unknown>,
      taskRoleIds: JSON.parse(row.taskRoleIds) as string[],
      permittedRecipientListIds: recipientLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      permittedLineListIds: lineLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rules could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; state?: string; selectionPolicy?: Record<string, unknown>; routingPolicy?: Record<string, unknown>; taskRoleIds?: unknown; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    const name = input.name?.trim();
    const state = (input.state ?? 'draft') as 'draft' | 'active' | 'suspended' | 'archived';
    if (!name) return failure(context, 'Rule name is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Rule State.');
    if (input.taskRoleIds !== undefined && (!Array.isArray(input.taskRoleIds) || input.taskRoleIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Task role IDs must be an array of stable identifiers.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(input.routingPolicy ?? {});
    const taskRoleIds = [...new Set((input.taskRoleIds ?? []) as string[])];
    const permittedRecipientListIds = [...new Set((input.permittedRecipientListIds ?? []) as string[])];
    const permittedLineListIds = [...new Set((input.permittedLineListIds ?? []) as string[])];
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    const database = drizzleOrganizationDatabase(access.database);
    if (taskRoleIds.length) {
      const existingRoles = await database.select({ id: operationalTaskRoles.id }).from(operationalTaskRoles)
        .where(inArray(operationalTaskRoles.id, taskRoleIds)).all();
      if (existingRoles.length !== taskRoleIds.length) return failure(context, 'Every Task role selected by a Rule must belong to the Organization.', 409);
    }
    const permittedListIds = [...permittedRecipientListIds, ...permittedLineListIds];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: organizationLists.id, kind: organizationLists.kind })
        .from(organizationLists).where(inArray(organizationLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Organization and have recipient kind.', 409);
      if (permittedLineListIds.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Organization and have line kind.', 409);
    }
    await database.batch([
      database.insert(organizationRules).values({
        id,
        organizationId: access.organization.id,
        name,
        status: state,
        selectionPolicy,
        routingPolicy,
        taskRoleIds: JSON.stringify(taskRoleIds),
        priority,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      database.insert(ruleRevisions).values({
        id: crypto.randomUUID(),
        ruleId: id,
        revision: 1,
        selectionPolicy,
        routingPolicy,
        taskRoleIds: JSON.stringify(taskRoleIds),
        createdAt: timestamp,
      }),
      ...permittedRecipientListIds.map((listId) => database.insert(rulePermittedRecipientLists).values({ ruleId: id, listId })),
      ...permittedLineListIds.map((listId) => database.insert(rulePermittedLineLists).values({ ruleId: id, listId })),
    ]);
    return json(context, { id, organizationId: access.organization.id, name, state, selectionPolicy: input.selectionPolicy ?? {}, routingPolicy: input.routingPolicy ?? {}, taskRoleIds, permittedRecipientListIds, permittedLineListIds, priority, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/rules/:ruleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ state?: string; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown }>();
    if (input.state !== undefined && !['draft', 'active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Rule State.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    if (input.state === undefined && input.permittedRecipientListIds === undefined && input.permittedLineListIds === undefined) return failure(context, 'No supported Rule changes were provided.');
    const database = drizzleOrganizationDatabase(access.database);
    const ruleId = context.req.param('ruleId');
    const existing = await database.select({ id: organizationRules.id }).from(organizationRules)
      .where(eq(organizationRules.id, ruleId)).get();
    if (!existing) return failure(context, 'Rule was not found.', 404);
    const permittedRecipientListIds = input.permittedRecipientListIds === undefined
      ? undefined
      : [...new Set(input.permittedRecipientListIds as string[])];
    const permittedLineListIds = input.permittedLineListIds === undefined
      ? undefined
      : [...new Set(input.permittedLineListIds as string[])];
    const permittedListIds = [...(permittedRecipientListIds ?? []), ...(permittedLineListIds ?? [])];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: organizationLists.id, kind: organizationLists.kind })
        .from(organizationLists).where(inArray(organizationLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds?.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Organization and have recipient kind.', 409);
      if (permittedLineListIds?.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Organization and have line kind.', 409);
    }
    if (input.state !== undefined) {
      await database.update(organizationRules)
        .set({ status: input.state as 'draft' | 'active' | 'suspended' | 'archived', updatedAt: now() })
        .where(eq(organizationRules.id, ruleId)).run();
    }
    if (permittedRecipientListIds !== undefined) {
      await database.batch([
        database.delete(rulePermittedRecipientLists).where(eq(rulePermittedRecipientLists.ruleId, ruleId)),
        ...permittedRecipientListIds.map((listId) => database.insert(rulePermittedRecipientLists).values({ ruleId, listId })),
      ]);
    }
    if (permittedLineListIds !== undefined) {
      await database.batch([
        database.delete(rulePermittedLineLists).where(eq(rulePermittedLineLists.ruleId, ruleId)),
        ...permittedLineListIds.map((listId) => database.insert(rulePermittedLineLists).values({ ruleId, listId })),
      ]);
    }
    return json(context, {
      id: ruleId,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(permittedRecipientListIds === undefined ? {} : { permittedRecipientListIds }),
      ...(permittedLineListIds === undefined ? {} : { permittedLineListIds }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/members', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      id: members.id,
      name: members.name,
      email: members.email,
      state: members.state,
      tags: members.tags,
      createdAt: members.createdAt,
      updatedAt: members.updatedAt,
      lineDestinationRowId: lineDestinations.id,
      lineDestinationId: lineDestinations.destinationId,
      lineDisplayName: lineDestinations.displayName,
      lineKind: lineDestinations.kind,
      lineStatus: lineDestinations.status,
      lineSource: lineDestinations.source,
    }).from(members)
      .leftJoin(memberLineDestinations, eq(memberLineDestinations.memberId, members.id))
      .leftJoin(lineDestinations, eq(lineDestinations.id, memberLineDestinations.lineDestinationId))
      .orderBy(asc(members.name)).all();
    const roster = new Map<string, {
      id: string;
      organizationId: string;
      name: string;
      email: string;
      state: 'active' | 'inactive';
      tags: string[];
      createdAt: string;
      updatedAt: string;
      lineDestinations: Array<{
        id: string;
        destinationId: string;
        displayName: string;
        kind: 'user' | 'group' | 'room';
        status: 'discovered' | 'disabled';
        source: 'webhook' | 'manual';
      }>;
    }>();
    for (const row of rows) {
      const member = roster.get(row.id) ?? {
        id: row.id,
        organizationId: access.organization.id,
        name: row.name,
        email: row.email,
        state: row.state,
        tags: JSON.parse(row.tags) as string[],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lineDestinations: [],
      };
      if (row.lineDestinationRowId && row.lineDestinationId && row.lineKind && row.lineStatus) {
        member.lineDestinations.push({
          id: row.lineDestinationRowId,
          destinationId: displayLineDestinationId(row.lineDestinationId),
          displayName: row.lineDisplayName ?? '',
          kind: row.lineKind,
          status: row.lineStatus,
          source: row.lineSource ?? 'webhook',
        });
      }
      roster.set(row.id, member);
    }
    return json(context, [...roster.values()]);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Members could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/line-destinations', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      id: lineDestinations.id,
      destinationId: lineDestinations.destinationId,
      displayName: lineDestinations.displayName,
      kind: lineDestinations.kind,
      status: lineDestinations.status,
      source: lineDestinations.source,
      discoveredAt: lineDestinations.discoveredAt,
      memberId: memberLineDestinations.memberId,
    }).from(lineDestinations)
      .leftJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
      .orderBy(desc(lineDestinations.discoveredAt)).all();
    return json(context, rows.map((row) => ({
      ...row,
      destinationId: displayLineDestinationId(row.destinationId),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destinations could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/line-destinations', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ destinationId?: string; kind?: string; displayName?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) return failure(context, 'A valid LINE ID is required.');
    const kind: 'user' | 'group' | 'room' = input.kind === 'group' || input.kind === 'room' ? input.kind : 'user';
    const displayName = input.displayName?.trim() ?? '';
    const database = drizzleOrganizationDatabase(access.database);
    const connection = await database.select({ id: organizationConnections.id }).from(organizationConnections).where(and(
      eq(organizationConnections.kind, 'line'),
      eq(organizationConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'A LINE Connection must be configured before a LINE Destination can be entered manually.', 409);
    const existing = await database.select({
      id: lineDestinations.id,
      memberId: memberLineDestinations.memberId,
    }).from(lineDestinations)
      .leftJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.memberId) return failure(context, 'This LINE ID is already linked to a member.', 409);
    const timestamp = now();
    if (existing) {
      await database.update(lineDestinations).set({
        kind,
        ...(displayName ? { displayName } : {}),
        status: 'discovered',
        updatedAt: timestamp,
      }).where(eq(lineDestinations.id, existing.id)).run();
      return json(context, {
        id: existing.id,
        destinationId: displayLineDestinationId(destinationId),
        displayName,
        kind,
        status: 'discovered' as const,
        source: 'manual' as const,
        discoveredAt: timestamp,
        memberId: null,
      });
    }
    const id = crypto.randomUUID();
    await database.insert(lineDestinations).values({
      id,
      connectionId: connection.id,
      destinationId,
      displayName,
      kind,
      status: 'discovered',
      source: 'manual',
      discoveredAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return json(context, {
      id,
      destinationId: displayLineDestinationId(destinationId),
      displayName,
      kind,
      status: 'discovered' as const,
      source: 'manual' as const,
      discoveredAt: timestamp,
      memberId: null,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be registered.', 409);
  }
});

app.delete('/api/organizations/:organizationId/line-destinations/:lineDestinationId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const lineDestinationId = context.req.param('lineDestinationId');
    const database = drizzleOrganizationDatabase(access.database);
    const existing = await database.select({
      id: lineDestinations.id,
      memberId: memberLineDestinations.memberId,
    }).from(lineDestinations)
      .leftJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
      .where(eq(lineDestinations.id, lineDestinationId))
      .get();
    if (!existing) return failure(context, 'LINE Destination was not found.', 404);
    if (existing.memberId) return failure(context, 'Unlink this LINE Destination from its member before removing it.', 409);
    await database.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    return json(context, { id: lineDestinationId, removed: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be removed.', 409);
  }
});

app.get('/api/organizations/:organizationId/members/export', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      name: members.name,
      email: members.email,
    }).from(members).where(eq(members.state, 'active')).orderBy(asc(members.name)).all();
    return new Response(exportMemberCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members.csv"' } });
  } catch (error) { return failure(context, error instanceof Error ? error.message : 'Member export could not be created.', 403); }
});

app.post('/api/organizations/:organizationId/members', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; tags?: unknown; lineDestinationId?: string }>();
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase() ?? '';
    if (!name) return failure(context, 'Member name is required.');
    if (email && !email.includes('@')) return failure(context, 'Member email address must be valid when provided.');
    const tags = input.tags === undefined ? [] : input.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
      return failure(context, 'Member tags must be non-empty strings.');
    }
    const normalizedTags = tags.map((tag) => String(tag).trim());
    const database = drizzleOrganizationDatabase(access.database);
    const requestedLineDestinationId = input.lineDestinationId?.trim();
    const lineDestination = requestedLineDestinationId
      ? await database.select({
        id: lineDestinations.id,
        destinationId: lineDestinations.destinationId,
        displayName: lineDestinations.displayName,
        kind: lineDestinations.kind,
        status: lineDestinations.status,
      }).from(lineDestinations)
        .leftJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
        .where(and(
          eq(lineDestinations.id, requestedLineDestinationId),
          eq(lineDestinations.status, 'discovered'),
          isNull(memberLineDestinations.memberId),
        )).get()
      : null;
    if (requestedLineDestinationId && !lineDestination) {
      return failure(context, 'The LINE Destination is unavailable or already assigned.', 409);
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    const memberInsert = database.insert(members).values({
      id,
      organizationId: access.organization.id,
      name,
      email,
      state: 'active',
      tags: JSON.stringify(normalizedTags),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (lineDestination) {
      await database.batch([
        memberInsert,
        database.insert(memberLineDestinations).values({
          memberId: id,
          lineDestinationId: lineDestination.id,
          createdAt: timestamp,
        }),
      ]);
    } else {
      await memberInsert.run();
    }
    return json(context, {
      id,
      organizationId: access.organization.id,
      name,
      email,
      state: 'active',
      tags: normalizedTags,
      createdAt: timestamp,
      updatedAt: timestamp,
      lineDestinations: lineDestination ? [{
        ...lineDestination,
        destinationId: displayLineDestinationId(lineDestination.destinationId),
      }] : [],
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/members/:memberId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; tags?: unknown; state?: string }>();
    const updates: Partial<typeof members.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return failure(context, 'Member name cannot be empty.');
      updates.name = name;
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email && !email.includes('@')) return failure(context, 'Member email address must be valid when provided.');
      updates.email = email;
    }
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) return failure(context, 'Member tags must be non-empty strings.');
      tags = input.tags.map((tag) => tag.trim());
      updates.tags = JSON.stringify(tags);
    }
    if (input.state !== undefined) {
      if (!['active', 'inactive'].includes(input.state)) return failure(context, 'Unsupported Member state.');
      updates.state = input.state as 'active' | 'inactive';
    }
    if (Object.keys(updates).length === 0) return failure(context, 'At least one Member field is required.');
    const updated = await drizzleOrganizationDatabase(access.database).update(members)
      .set({ ...updates, updatedAt: now() })
      .where(eq(members.id, context.req.param('memberId')))
      .returning({ id: members.id }).get();
    if (!updated) return failure(context, 'Member was not found.', 404);
    return json(context, {
      id: context.req.param('memberId'),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      ...(tags === undefined ? {} : { tags }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/members/:memberId/line-links', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.update(memberLinkTokens).set({ usedAt: timestamp }).where(and(
        eq(memberLinkTokens.memberId, context.req.param('memberId')),
        isNull(memberLinkTokens.usedAt),
      )),
      database.insert(memberLinkTokens).values({
        token,
        memberId: context.req.param('memberId'),
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      }),
    ]);
    return json(context, {
      memberId: context.req.param('memberId'),
      token,
      expiresAt,
      linkUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.organization.id)}/line-links/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member Link could not be issued.', 409);
  }
});

app.post('/api/organizations/:organizationId/members/:memberId/portal-invitations', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const memberId = context.req.param('memberId');
    const database = drizzleOrganizationDatabase(access.database);
    // ADR 0119: the invitation is delivered to the Member's LINE Destination,
    // and no alternative delivery is provided.
    const reachable = await database.select({ memberId: memberLineDestinations.memberId })
      .from(memberLineDestinations).where(eq(memberLineDestinations.memberId, memberId)).get();
    if (!reachable) return failure(context, 'LINE連携のないメンバーはMember Portalを利用できません。', 409);
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    await database.batch([
      database.update(portalInvitations).set({ usedAt: timestamp }).where(and(
        eq(portalInvitations.memberId, memberId),
        isNull(portalInvitations.usedAt),
      )),
      database.insert(portalInvitations).values({ token, memberId, expiresAt, usedAt: null, createdAt: timestamp }),
    ]);
    return json(context, {
      memberId,
      expiresAt,
      portalUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/portal/join/${encodeURIComponent(access.organization.id)}/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Portal invitation could not be issued.', 409);
  }
});

app.put('/api/organizations/:organizationId/members/:memberId/line-destination', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ destinationId?: string; kind?: string; displayName?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) return failure(context, 'A valid LINE ID is required.');
    const kind: 'user' | 'group' | 'room' = input.kind === 'group' || input.kind === 'room' ? input.kind : 'user';
    const displayName = input.displayName?.trim() ?? '';
    const memberId = context.req.param('memberId');
    const database = drizzleOrganizationDatabase(access.database);
    const member = await database.select({ id: members.id })
      .from(members).where(eq(members.id, memberId)).get();
    if (!member) return failure(context, 'Member was not found.', 404);
    const connection = await database.select({ id: organizationConnections.id }).from(organizationConnections).where(and(
      eq(organizationConnections.kind, 'line'),
      eq(organizationConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'A LINE Connection must be configured before a LINE Destination can be entered manually.', 409);
    const existing = await database.select({
      id: lineDestinations.id,
      source: lineDestinations.source,
      memberId: memberLineDestinations.memberId,
    }).from(lineDestinations)
      .leftJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.memberId && existing.memberId !== memberId) {
      return failure(context, 'This LINE ID is already linked to another member.', 409);
    }
    const previousManual = await database.select({ id: lineDestinations.id }).from(lineDestinations)
      .innerJoin(memberLineDestinations, eq(memberLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(
        eq(memberLineDestinations.memberId, memberId),
        eq(lineDestinations.source, 'manual'),
        ne(lineDestinations.id, existing?.id ?? ''),
      )).get();
    if (previousManual) await database.delete(lineDestinations).where(eq(lineDestinations.id, previousManual.id)).run();
    const timestamp = now();
    const lineDestinationId = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await database.update(lineDestinations).set({
        kind,
        ...(displayName ? { displayName } : {}),
        status: 'discovered',
        updatedAt: timestamp,
      }).where(eq(lineDestinations.id, existing.id)).run();
    } else {
      await database.insert(lineDestinations).values({
        id: lineDestinationId,
        connectionId: connection.id,
        destinationId,
        displayName,
        kind,
        status: 'discovered',
        source: 'manual',
        discoveredAt: timestamp,
        updatedAt: timestamp,
      }).run();
    }
    if (!existing?.memberId) {
      await database.insert(memberLineDestinations).values({
        memberId,
        lineDestinationId,
        createdAt: timestamp,
      }).run();
    }
    return json(context, {
      id: lineDestinationId,
      destinationId: displayLineDestinationId(destinationId),
      displayName,
      kind,
      status: 'discovered' as const,
      source: existing?.source ?? 'manual',
    }, existing ? 200 : 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be saved.', 409);
  }
});

app.delete('/api/organizations/:organizationId/members/:memberId/line-destination/:lineDestinationId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const memberId = context.req.param('memberId');
    const lineDestinationId = context.req.param('lineDestinationId');
    const database = drizzleOrganizationDatabase(access.database);
    const link = await database.select({
      lineDestinationId: memberLineDestinations.lineDestinationId,
      source: lineDestinations.source,
    }).from(memberLineDestinations)
      .innerJoin(lineDestinations, eq(lineDestinations.id, memberLineDestinations.lineDestinationId))
      .where(and(
        eq(memberLineDestinations.memberId, memberId),
        eq(memberLineDestinations.lineDestinationId, lineDestinationId),
      )).get();
    if (!link) return failure(context, 'LINE Destination link was not found.', 404);
    if (link.source === 'manual') {
      await database.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    } else {
      await database.delete(memberLineDestinations).where(and(
        eq(memberLineDestinations.memberId, memberId),
        eq(memberLineDestinations.lineDestinationId, lineDestinationId),
      )).run();
    }
    return json(context, { id: lineDestinationId, unlinked: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be unlinked.', 409);
  }
});

app.post('/api/organizations/:organizationId/members/import/preview', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    return json(context, previewMemberCsv(input.csv));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member import could not be previewed.', 409);
  }
});

app.post('/api/organizations/:organizationId/members/import', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    const preview = previewMemberCsv(input.csv);
    const timestamp = now();
    const database = drizzleOrganizationDatabase(access.database);
    const writes = await Promise.all(preview.accepted.map((member) => database.insert(members).values({
      id: crypto.randomUUID(),
      organizationId: access.organization.id,
      name: member.name,
      email: member.email,
      state: 'active',
      tags: '[]',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning({ id: members.id }).get()));
    const imported = writes.filter(Boolean).length;
    return json(context, { imported, duplicates: preview.duplicates, invalid: preview.invalid }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member import could not be completed.', 409);
  }
});

app.get('/api/organizations/:organizationId/dashboard', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const database = drizzleOrganizationDatabase(access.database);
    const [rules, activeAgentRules, events, jobs, exceptions, connection] = await Promise.all([
      database.select({ value: count() }).from(organizationRules).where(eq(organizationRules.status, 'active')).get(),
      database.select({ value: count() }).from(agentRules).where(eq(agentRules.status, 'active')).get(),
      database.select({ value: count() }).from(organizationEvents).where(and(eq(organizationEvents.status, 'scheduled'), gte(organizationEvents.startsAt, now()))).get(),
      database.select({ value: count() }).from(organizationJobs).where(inArray(organizationJobs.state, ['pending', 'running'])).get(),
      database.select({ value: count() }).from(organizationExceptions).where(eq(organizationExceptions.state, 'open')).get(),
      database.select({ value: max(googleConnections.updatedAt) }).from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get(),
    ]);
    return json(context, {
      activeRules: (rules?.value ?? 0) + (activeAgentRules?.value ?? 0),
      upcomingEvents: events?.value ?? 0,
      pendingJobs: jobs?.value ?? 0,
      exceptions: exceptions?.value ?? 0,
      lastSyncedAt: connection?.value ?? null,
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Dashboard could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/task-roles', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ displayName?: string; description?: string }>();
    const displayName = input.displayName?.trim() ?? '';
    const description = input.description?.trim() ?? '';
    if (!displayName || displayName.length > 100) return failure(context, 'A role display name of at most 100 characters is required.');
    if (!description || description.length > 500) return failure(context, 'A role description of at most 500 characters is required.');
    const role = await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).createRole({ displayName, description });
    return json(context, role, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational Task Role could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/task-roles/:roleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ displayName?: string; description?: string }>();
    const displayName = input.displayName?.trim();
    const description = input.description?.trim();
    if (displayName !== undefined && (!displayName || displayName.length > 100)) return failure(context, 'A role display name of at most 100 characters is required.');
    if (description !== undefined && (!description || description.length > 500)) return failure(context, 'A role description of at most 500 characters is required.');
    const role = await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).updateRole(context.req.param('roleId'), {
      ...(displayName === undefined ? {} : { displayName }),
      ...(description === undefined ? {} : { description }),
    });
    if (!role) return failure(context, 'Operational Task Role was not found or no change was supplied.', 404);
    return json(context, role);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational Task Role could not be updated.', 409);
  }
});

app.delete('/api/organizations/:organizationId/task-roles/:roleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    if (!await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).deleteRole(context.req.param('roleId'))) return failure(context, 'Operational Task Role was not found.', 404);
    return json(context, { id: context.req.param('roleId'), removed: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational Task Role could not be removed.', 409);
  }
});

app.put('/api/organizations/:organizationId/task-roles/:roleId/assignment', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const roleId = context.req.param('roleId');
    const database = drizzleOrganizationDatabase(access.database);
    if (!await database.select({ id: operationalTaskRoles.id }).from(operationalTaskRoles).where(eq(operationalTaskRoles.id, roleId)).get()) return failure(context, 'Operational Task Role was not found.', 404);
    const input = await context.req.json<{ memberId?: string }>();
    if (!input.memberId) return failure(context, 'An active Member is required.');
    const member = await database.select({ memberId: members.id, displayName: members.name })
      .from(members).where(and(eq(members.id, input.memberId), eq(members.state, 'active'))).get();
    if (!member) return failure(context, 'Operational Task Roles can only be assigned to an active Member.', 409);
    await createTaskWorkflow(database).assignRole({
      roleId,
      memberId: member.memberId,
      displayName: member.displayName,
    });
    return json(context, { roleId, ...member });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational task role could not be saved.', 409);
  }
});

app.get('/api/organizations/:organizationId/task-roles', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const database = drizzleOrganizationDatabase(access.database);
    const [assignable, roles, assignments] = await Promise.all([
      database.select({ memberId: members.id, displayName: members.name }).from(members)
        .where(eq(members.state, 'active')).orderBy(asc(members.name)).all(),
      createTaskWorkflow(database).listRoles(),
      database.select().from(taskRoleAssignments).all(),
    ]);
    return json(context, { members: assignable, roles, assignments });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational task roles could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/tasks', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const assignee = context.req.query('assignee')?.trim();
    const event = context.req.query('event')?.trim();
    return json(context, await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).list({
      ...(assignee === 'unassigned' ? { unassigned: true } : assignee ? { assigneeMemberId: assignee } : {}),
      ...(event ? { event } : {}),
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Tasks could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/automation-warnings', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const rows = await drizzleOrganizationDatabase(access.database).select().from(automationWarnings)
      .orderBy(desc(automationWarnings.createdAt)).limit(100).all();
    return json(context, rows);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Warnings could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/tasks/:taskId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ completed?: unknown; remarks?: unknown }>();
    if (input.completed !== undefined && typeof input.completed !== 'boolean') return failure(context, 'Completed must be a boolean.');
    if (input.remarks !== undefined && (typeof input.remarks !== 'string' || input.remarks.length > 10_000)) return failure(context, 'Remarks must be at most 10,000 characters.');
    const task = await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).update(context.req.param('taskId'), {
      ...(typeof input.completed === 'boolean' ? { completed: input.completed } : {}),
      ...(typeof input.remarks === 'string' ? { remarks: input.remarks } : {}),
    });
    if (!task) return failure(context, 'Task was not found or no change was supplied.', 404);
    return json(context, task);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Task could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/recovery-requests', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    const input = await context.req.json<{ idempotencyKey?: string }>();
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) return failure(context, 'A recovery receipt idempotency key is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    await drizzleControlDatabase(context.env.CONTROL_DB).insert(recoveryRequests).values({
      id,
      organizationId: access.organization.id,
      idempotencyKey,
      state: 'requested',
      requestedByIdentityId: access.session.identity_id,
      createdAt: timestamp,
    }).run();
    return json(context, { id, organizationId: access.organization.id, idempotencyKey, state: 'requested', createdAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery request could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/events/:eventId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ title?: string; startsAt?: string; endsAt?: string; location?: string; description?: string; status?: string; reason?: string }>();
    const changeSet = {
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt.trim() }),
      ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt.trim() }),
      ...(input.location === undefined ? {} : { location: input.location.trim() }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.status === undefined ? {} : { status: input.status.trim() }),
    };
    if (!Object.keys(changeSet).length || Object.values(changeSet).some((value) => value === '')) return failure(context, 'At least one non-empty Event field is required.');
    const status = changeSet.status;
    if (status && !['draft', 'scheduled', 'cancelled', 'exception'].includes(status)) return failure(context, 'Unsupported Event status.');
    const updates: Partial<typeof organizationEvents.$inferInsert> = {};
    if (changeSet.title !== undefined) updates.title = changeSet.title;
    if (changeSet.startsAt !== undefined) updates.startsAt = changeSet.startsAt;
    if (changeSet.endsAt !== undefined) updates.endsAt = changeSet.endsAt;
    if (changeSet.location !== undefined) updates.location = changeSet.location;
    if (changeSet.description !== undefined) updates.description = changeSet.description;
    if (status !== undefined) updates.status = status as 'draft' | 'scheduled' | 'cancelled' | 'exception';
    const timestamp = now();
    const database = drizzleOrganizationDatabase(access.database);
    const updated = await database.update(organizationEvents).set({ ...updates, updatedAt: timestamp })
      .where(eq(organizationEvents.id, context.req.param('eventId')))
      .returning({ id: organizationEvents.id }).get();
    if (!updated) return failure(context, 'Event was not found.', 404);
    await database.insert(eventOverrides).values({
      id: crypto.randomUUID(),
      eventId: context.req.param('eventId'),
      actorIdentityId: access.session.identity_id,
      changesJson: JSON.stringify(changeSet),
      reason: input.reason?.trim() ?? '',
      createdAt: timestamp,
    }).run();
    return json(context, { id: context.req.param('eventId'), updatedFields: Object.keys(changeSet) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Event could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/events/:eventId/recipient-snapshots', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ memberIds?: unknown }>();
    if (!Array.isArray(input.memberIds) || !input.memberIds.length || input.memberIds.some((id) => typeof id !== 'string' || !id.trim())) return failure(context, 'At least one Member is required.');
    const memberIds = [...new Set(input.memberIds.map((id) => id.trim()))];
    const database = drizzleOrganizationDatabase(access.database);
    const recipients = await database.select({
      id: members.id,
      name: members.name,
      email: members.email,
    }).from(members).where(and(
      inArray(members.id, memberIds),
      eq(members.state, 'active'),
    )).all();
    if (recipients.length !== memberIds.length) return failure(context, 'One or more active Members were not found.', 404);
    const timestamp = now();
    await Promise.all(recipients.map((recipient) => database.insert(attendance).values({
      eventId: context.req.param('eventId'),
      memberId: recipient.id,
      status: 'unanswered',
      comment: '',
      updatedAt: now(),
    }).onConflictDoNothing().run()));
    await Promise.all(recipients.map((recipient) => database.insert(eventRecipients).values({
      eventId: context.req.param('eventId'),
      memberId: recipient.id,
      nameSnapshot: recipient.name,
      emailSnapshot: recipient.email,
      createdAt: timestamp,
    }).onConflictDoNothing().run()));
    return json(context, { eventId: context.req.param('eventId'), snapshotted: recipients.length }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient snapshots could not be created.', 409);
  }
});

app.get('/api/organizations/:organizationId/audit/deliveries', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationDeliveries)
      .orderBy(desc(organizationDeliveries.createdAt)).limit(100).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      sourceMessageId: row.sourceMessageId,
      channel: row.channel,
      destination: row.channel === 'line'
        ? displayLineDestinationId(row.destination)
        : row.destination,
      outcome: row.outcome,
      externalId: row.externalId,
      createdAt: row.createdAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Delivery audit could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/operations/exceptions', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationExceptions)
      .orderBy(desc(organizationExceptions.createdAt)).limit(100).all();
    return json(context, rows.map((row) => ({
      id: row.id, sourceMessageId: row.sourceMessageId, code: row.code, message: row.message, state: row.state, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exceptions could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/operations/exceptions/:exceptionId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ action?: string }>();
    const database = drizzleOrganizationDatabase(access.database);
    if (input.action === 'resolve') {
      const updated = await database.update(organizationExceptions).set({ state: 'resolved', resolvedAt: now() }).where(and(
        eq(organizationExceptions.id, context.req.param('exceptionId')),
        ne(organizationExceptions.state, 'resolved'),
      )).returning({ id: organizationExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found or already resolved.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'resolved' });
    }
    if (input.action === 'retry') {
      const updated = await database.update(organizationExceptions).set({ state: 'retry_requested', resolvedAt: null })
        .where(eq(organizationExceptions.id, context.req.param('exceptionId')))
        .returning({ id: organizationExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'retry_requested' });
    }
    return failure(context, 'Unsupported Exception action.');
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exception could not be updated.', 409);
  }
});

app.post('/api/public/organizations/:organizationId/line/webhook', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'LINE webhook was not found.', 404);
    const organizationDb = drizzleOrganizationDatabase(database);
    const connection = await organizationDb.select().from(organizationConnections).where(and(
      eq(organizationConnections.kind, 'line'),
      eq(organizationConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'LINE webhook was not found.', 404);
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const credential = await connectionCredential(connection, organizationKey, organizationId, 'line');
    const rawBody = await context.req.text();
    const signature = context.req.header('x-line-signature') ?? '';
    if (!credential.channelSecret || !await verifyLineWebhookSignature(credential.channelSecret, rawBody, signature)) return failure(context, 'Invalid LINE webhook signature.', 401);
    const payload = JSON.parse(rawBody) as LineWebhookPayload;
    const destinations = discoveredLineDestinations(payload);
    const timestamp = now();
    const persistence = Promise.all(destinations.map(async (destination) => {
      const displayName = await lineDestinationDisplayName(credential, destination, payload);
      await organizationDb.insert(lineDestinations).values({
        id: crypto.randomUUID(),
        connectionId: connection.id,
        destinationId: destination.destinationId,
        displayName,
        kind: destination.kind,
        status: 'discovered',
        discoveredAt: timestamp,
        updatedAt: timestamp,
      }).onConflictDoUpdate({
        target: [lineDestinations.connectionId, lineDestinations.destinationId],
        set: {
          ...(displayName ? { displayName } : {}),
          status: 'discovered',
          updatedAt: timestamp,
        },
      }).run();
    }));
    context.executionCtx.waitUntil(persistence);
    return json(context, { discovered: destinations.length });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE webhook could not be processed.', 400);
  }
});

app.post('/api/public/organizations/:organizationId/line-links/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'Member Link was not found.', 404);
    const organizationDb = drizzleOrganizationDatabase(database);
    const input = await context.req.json<{ destinationId?: string }>();
    if (!input.destinationId?.trim()) return failure(context, 'A discovered LINE Destination is required.');
    const link = await organizationDb.select({
      memberId: memberLinkTokens.memberId,
    }).from(memberLinkTokens).where(and(
      eq(memberLinkTokens.token, context.req.param('token')),
      isNull(memberLinkTokens.usedAt),
      gt(memberLinkTokens.expiresAt, now()),
    )).get();
    if (!link) return failure(context, 'Member Link has expired or was already used.', 410);
    const destination = await organizationDb.select({ id: lineDestinations.id }).from(lineDestinations).where(and(
      eq(lineDestinations.destinationId, input.destinationId.trim()),
      eq(lineDestinations.status, 'discovered'),
    )).limit(1).get();
    if (!destination) return failure(context, 'LINE Destination was not found.', 404);
    const timestamp = now();
    await organizationDb.insert(memberLineDestinations).values({
      memberId: link.memberId,
      lineDestinationId: destination.id,
      createdAt: timestamp,
    }).onConflictDoNothing().run();
    const consumed = await organizationDb.update(memberLinkTokens).set({ usedAt: timestamp }).where(and(
      eq(memberLinkTokens.token, context.req.param('token')),
      isNull(memberLinkTokens.usedAt),
    )).returning({ token: memberLinkTokens.token }).get();
    if (!consumed) return failure(context, 'Member Link was already used.', 410);
    return json(context, {
      memberId: link.memberId,
      destinationId: displayLineDestinationId(input.destinationId.trim()),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member Link could not be consumed.', 409);
  }
});

app.patch('/api/organizations/:organizationId/suspension', async (context) => {
  try {
    const session = await sessionFromRequest(context.req.raw, context.env);
    if (!session) return failure(context, 'Authentication is required.', 401);
    const organizationId = context.req.param('organizationId');
    const control = drizzleControlDatabase(context.env.CONTROL_DB);
    const membership = await control.select({
      id: organizations.id,
      status: organizations.status,
    }).from(admins).innerJoin(organizations, eq(organizations.id, admins.organizationId)).where(and(
      eq(admins.identityId, session.identity_id),
      eq(admins.organizationId, organizationId),
      eq(admins.state, 'active'),
    )).get();
    if (!membership) return failure(context, 'この組織へのアクセス権がありません。', 403);
    const input = await context.req.json<{ suspended?: boolean }>();
    if (typeof input.suspended !== 'boolean') return failure(context, 'A suspension state is required.');
    const status = input.suspended ? 'suspended' : 'active';
    await control.update(organizations).set({ status, updatedAt: now() })
      .where(eq(organizations.id, organizationId)).run();
    return json(context, { organizationId, status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Organization suspension could not be changed.', 409);
  }
});

app.all('/api/*', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  return failure(context, 'The previous shared-ORG_DB management API has been retired. Organization-scoped operations are introduced in the next implementation unit.', 410);
});

const sessionFromRequest = async (request: Request, env: Bindings): Promise<SessionRow | null> => {
  return createRequestContext(request, env).session();
};

export { app };
