import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, max, ne } from 'drizzle-orm';

import { canUpdateAttendance, discoveredLineDestinations, displayRecipientIdentifier, verifyLineWebhookSignature } from '@mail/domain';

import { createAutomation, LEGACY_AI_BASE_URL } from './automation';
import { decrypt, encrypt } from './cryptography';
import { randomToken } from './encoding';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt } from './recovery-receipts';
import { exportRecipientCsv, previewRecipientCsv } from './recipients';
import { failure, json } from './response';
import { entryRoutes, oauthRoutes } from './routes/entry';
import { automationRoutes } from './routes/automation';
import { createRequestContext } from './routes/request-context';
import { typedListRoutes } from './routes/typed-lists';
import type { Bindings, ConnectionRow, SessionRow } from './types';
import type { CipherEnvelope } from './cryptography';
import { openAiChatCompletionsUrl, type EventDetails, type MailExtraction, type TaskDetails } from './event-details';
import { createTaskWorkflow, type OperationalTaskRole } from './tasks';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { createOrganizationStore } from './storage/organization-store';
import { identities, members, organizations, recoveryRequests } from './storage/control-schema';
import {
  attendance,
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
  recipientLineDestinations,
  recipientLinkTokens,
  recipientProfiles,
  ruleRevisions,
  rules as organizationRules,
  taskRoleAssignments,
} from './storage/organization-schema';

const RECIPIENT_LINK_WINDOW_MS = 15 * 60 * 1_000;
type OrganizationCredential = Record<string, string>;

interface OrganizationConnectionInput {
  line?: {
    channelAccessToken?: string;
    channelSecret?: string;
  };
  ai?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
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
    && Number.isFinite(Date.parse(event.startsAt))
    && Number.isFinite(Date.parse(event.endsAt))
    && Date.parse(event.startsAt) < Date.parse(event.endsAt);
};

const isTaskDetails = (value: unknown): value is TaskDetails => {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskDetails>;
  return typeof task.title === 'string' && Boolean(task.title.trim())
    && typeof task.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(task.deadline)
    && (task.assigneeRole === 'organizer' || task.assigneeRole === 'treasurer')
    && typeof task.description === 'string' && Boolean(task.description.trim());
};

const isMailExtraction = (value: unknown): value is MailExtraction => {
  if (!value || typeof value !== 'object') return false;
  const extraction = value as Partial<MailExtraction>;
  return Array.isArray(extraction.events) && extraction.events.length > 0 && extraction.events.every(isEventDetails)
    && Array.isArray(extraction.tasks) && extraction.tasks.every(isTaskDetails);
};

const connectionContext = (organizationId: string, kind: 'line' | 'ai'): string => `organization-connection:${organizationId}:${kind}`;

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
    return json(context, { organizationId, organizationName: access.organization.name, ...connectionView(lineCredential, aiCredential) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を取得できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:organizationId/connections', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, '接続設定を変更できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const database = access.database;
    const db = drizzleOrganizationDatabase(database);
    const input = await context.req.json<OrganizationConnectionInput>();
    const rows = await db.select().from(organizationConnections)
      .where(and(inArray(organizationConnections.kind, ['line', 'ai']), eq(organizationConnections.status, 'active'))).all();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const existingLine = rows.find((row) => row.kind === 'line');
    const existingAi = rows.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(existingLine ?? null, organizationKey, organizationId, 'line'),
      connectionCredential(existingAi ?? null, organizationKey, organizationId, 'ai'),
    ]);
    const nextLine: OrganizationCredential = { ...lineCredential, ...input.line };
    const nextAi: OrganizationCredential = { ...aiCredential, ...input.ai };
    const updatingLine = Boolean(input.line?.channelAccessToken || input.line?.channelSecret);
    if (updatingLine && (!nextLine.channelAccessToken || !nextLine.channelSecret)) return failure(context, 'LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    const aiBaseUrl = normalizedAiBaseUrl(nextAi.baseUrl);
    const aiModel = nextAi.model?.trim();
    if (!nextAi.apiKey || !aiModel || !aiBaseUrl) return failure(context, 'OpenAI 互換 API の Base URL、model、API キーを入力してください。');
    if (aiModel.length > 200) return failure(context, 'model は 200 文字以内で入力してください。');
    nextAi.provider = 'OpenAI-compatible API';
    nextAi.model = aiModel;
    nextAi.baseUrl = aiBaseUrl;
    const timestamp = now();
    const lineEnvelope = await encrypt(JSON.stringify(nextLine), organizationKey, connectionContext(organizationId, 'line'));
    const aiEnvelope = await encrypt(JSON.stringify(nextAi), organizationKey, connectionContext(organizationId, 'ai'));
    const save = async (existing: typeof organizationConnections.$inferSelect | undefined, kind: 'line' | 'ai', label: string, credential: string): Promise<void> => {
      if (existing) {
        await db.update(organizationConnections).set({ label, credential, status: 'active', updatedAt: timestamp })
          .where(eq(organizationConnections.id, existing.id)).run();
        return;
      }
      await db.insert(organizationConnections).values({ id: crypto.randomUUID(), kind, label, credential, status: 'active', createdAt: timestamp, updatedAt: timestamp }).run();
    };
    await Promise.all([
      save(existingLine, 'line', 'LINE Messaging API', JSON.stringify(lineEnvelope)),
      save(existingAi, 'ai', 'OpenAI 互換 API', JSON.stringify(aiEnvelope)),
    ]);
    return json(context, { organizationId, organizationName: access.organization.name, ...connectionView(nextLine, nextAi) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を保存できませんでした。';
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'メールの手動テストを実行できる権限がありません。', 403);
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'メールの手動テストを実行できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await createAutomation(context.env).mailboxTest.readSource({ organizationId, database: access.database, messageId });
    const request = await createAutomation(context.env).mailboxTest.previewAiRequest({ source: source.source, attachments: source.attachments });
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'メールの手動テストを実行できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await createAutomation(context.env).mailboxTest.readSource({ organizationId, database: access.database, messageId });
    const extraction = await createAutomation(context.env).mailboxTest.extractPackage({
      organizationId,
      database: access.database,
      source: source.source,
      attachments: source.attachments,
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'テスト予定を作成できる権限がありません。', 403);
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Typed Lists can only be changed by an Owner or Admin.', 403);
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'List Items can only be changed by an Owner or Admin.', 403);
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'List Items can only be changed by an Owner or Admin.', 403);
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

app.get('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationRules)
      .orderBy(desc(organizationRules.priority), asc(organizationRules.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      state: row.status,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routingPolicy) as Record<string, unknown>,
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
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Rules can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; state?: string; selectionPolicy?: Record<string, unknown>; routingPolicy?: Record<string, unknown>; priority?: number }>();
    const name = input.name?.trim();
    const state = (input.state ?? 'draft') as 'draft' | 'active' | 'suspended' | 'archived';
    if (!name) return failure(context, 'Rule name is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Rule State.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(input.routingPolicy ?? {});
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.insert(organizationRules).values({
        id,
        organizationId: access.organization.id,
        name,
        status: state,
        selectionPolicy,
        routingPolicy,
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
        createdAt: timestamp,
      }),
    ]);
    return json(context, { id, organizationId: access.organization.id, name, state, selectionPolicy: input.selectionPolicy ?? {}, routingPolicy: input.routingPolicy ?? {}, priority, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/rules/:ruleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Rules can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ state?: string }>();
    if (!input.state || !['draft', 'active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Rule State.');
    const state = input.state as 'draft' | 'active' | 'suspended' | 'archived';
    const updated = await drizzleOrganizationDatabase(access.database).update(organizationRules)
      .set({ status: state, updatedAt: now() })
      .where(eq(organizationRules.id, context.req.param('ruleId')))
      .returning({ id: organizationRules.id }).get();
    if (!updated) return failure(context, 'Rule was not found.', 404);
    return json(context, { id: context.req.param('ruleId'), state: input.state });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/recipients', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      id: recipientProfiles.id,
      name: recipientProfiles.name,
      email: recipientProfiles.email,
      state: recipientProfiles.state,
      tags: recipientProfiles.tags,
      createdAt: recipientProfiles.createdAt,
      updatedAt: recipientProfiles.updatedAt,
      lineDestinationRowId: lineDestinations.id,
      lineDestinationId: lineDestinations.destinationId,
      lineDisplayName: lineDestinations.displayName,
      lineKind: lineDestinations.kind,
      lineStatus: lineDestinations.status,
      lineSource: lineDestinations.source,
    }).from(recipientProfiles)
      .leftJoin(recipientLineDestinations, eq(recipientLineDestinations.recipientProfileId, recipientProfiles.id))
      .leftJoin(lineDestinations, eq(lineDestinations.id, recipientLineDestinations.lineDestinationId))
      .orderBy(asc(recipientProfiles.name)).all();
    const recipients = new Map<string, {
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
      const recipient = recipients.get(row.id) ?? {
        id: row.id,
        organizationId: access.organization.id,
        name: row.name,
        email: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.email),
        state: row.state,
        tags: JSON.parse(row.tags) as string[],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lineDestinations: [],
      };
      if (row.lineDestinationRowId && row.lineDestinationId && row.lineKind && row.lineStatus) {
        recipient.lineDestinations.push({
          id: row.lineDestinationRowId,
          destinationId: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.lineDestinationId),
          displayName: row.lineDisplayName ?? '',
          kind: row.lineKind,
          status: row.lineStatus,
          source: row.lineSource ?? 'webhook',
        });
      }
      recipients.set(row.id, recipient);
    }
    return json(context, [...recipients.values()]);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profiles could not be loaded.', 403);
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
      recipientProfileId: recipientLineDestinations.recipientProfileId,
    }).from(lineDestinations)
      .leftJoin(recipientLineDestinations, eq(recipientLineDestinations.lineDestinationId, lineDestinations.id))
      .orderBy(desc(lineDestinations.discoveredAt)).all();
    return json(context, rows.map((row) => ({
      ...row,
      destinationId: displayRecipientIdentifier(
        access.role as 'owner' | 'admin' | 'operator' | 'viewer',
        row.destinationId,
      ),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destinations could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/recipients/export', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      name: recipientProfiles.name,
      email: recipientProfiles.email,
    }).from(recipientProfiles).where(eq(recipientProfiles.state, 'active')).orderBy(asc(recipientProfiles.name)).all();
    return new Response(exportRecipientCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="recipients.csv"' } });
  } catch (error) { return failure(context, error instanceof Error ? error.message : 'Recipient export could not be created.', 403); }
});

app.post('/api/organizations/:organizationId/recipients', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Profiles can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; tags?: unknown; lineDestinationId?: string }>();
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase();
    if (!name || !email || !email.includes('@')) return failure(context, 'Recipient name and a valid email address are required.');
    const tags = input.tags === undefined ? [] : input.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
      return failure(context, 'Recipient tags must be non-empty strings.');
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
        .leftJoin(recipientLineDestinations, eq(recipientLineDestinations.lineDestinationId, lineDestinations.id))
        .where(and(
          eq(lineDestinations.id, requestedLineDestinationId),
          eq(lineDestinations.status, 'discovered'),
          isNull(recipientLineDestinations.recipientProfileId),
        )).get()
      : null;
    if (requestedLineDestinationId && !lineDestination) {
      return failure(context, 'The LINE Destination is unavailable or already assigned.', 409);
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    const recipientInsert = database.insert(recipientProfiles).values({
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
        recipientInsert,
        database.insert(recipientLineDestinations).values({
          recipientProfileId: id,
          lineDestinationId: lineDestination.id,
          createdAt: timestamp,
        }),
      ]);
    } else {
      await recipientInsert.run();
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
      lineDestinations: lineDestination ? [lineDestination] : [],
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profile could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/recipients/:recipientId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Profiles can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; tags?: unknown; state?: string }>();
    const updates: Partial<typeof recipientProfiles.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return failure(context, 'Recipient name cannot be empty.');
      updates.name = name;
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (!email.includes('@')) return failure(context, 'A valid Recipient email address is required.');
      updates.email = email;
    }
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) return failure(context, 'Recipient tags must be non-empty strings.');
      tags = input.tags.map((tag) => tag.trim());
      updates.tags = JSON.stringify(tags);
    }
    if (input.state !== undefined) {
      if (!['active', 'inactive'].includes(input.state)) return failure(context, 'Unsupported Recipient state.');
      updates.state = input.state as 'active' | 'inactive';
    }
    if (Object.keys(updates).length === 0) return failure(context, 'At least one Recipient field is required.');
    const updated = await drizzleOrganizationDatabase(access.database).update(recipientProfiles)
      .set({ ...updates, updatedAt: now() })
      .where(eq(recipientProfiles.id, context.req.param('recipientId')))
      .returning({ id: recipientProfiles.id }).get();
    if (!updated) return failure(context, 'Recipient Profile was not found.', 404);
    return json(context, {
      id: context.req.param('recipientId'),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      ...(tags === undefined ? {} : { tags }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profile could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/:recipientId/line-links', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Links can only be issued by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.update(recipientLinkTokens).set({ usedAt: timestamp }).where(and(
        eq(recipientLinkTokens.recipientProfileId, context.req.param('recipientId')),
        isNull(recipientLinkTokens.usedAt),
      )),
      database.insert(recipientLinkTokens).values({
        token,
        recipientProfileId: context.req.param('recipientId'),
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      }),
    ]);
    return json(context, {
      recipientProfileId: context.req.param('recipientId'),
      token,
      expiresAt,
      linkUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.organization.id)}/line-links/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Link could not be issued.', 409);
  }
});

const LINE_DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

app.put('/api/organizations/:organizationId/recipients/:recipientId/line-destination', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'LINE Destinations can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ destinationId?: string; kind?: string; displayName?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) return failure(context, 'A valid LINE ID is required.');
    const kind: 'user' | 'group' | 'room' = input.kind === 'group' || input.kind === 'room' ? input.kind : 'user';
    const displayName = input.displayName?.trim() ?? '';
    const recipientId = context.req.param('recipientId');
    const database = drizzleOrganizationDatabase(access.database);
    const recipient = await database.select({ id: recipientProfiles.id })
      .from(recipientProfiles).where(eq(recipientProfiles.id, recipientId)).get();
    if (!recipient) return failure(context, 'Recipient Profile was not found.', 404);
    const connection = await database.select({ id: organizationConnections.id }).from(organizationConnections).where(and(
      eq(organizationConnections.kind, 'line'),
      eq(organizationConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'A LINE Connection must be configured before a LINE Destination can be entered manually.', 409);
    const existing = await database.select({
      id: lineDestinations.id,
      source: lineDestinations.source,
      recipientProfileId: recipientLineDestinations.recipientProfileId,
    }).from(lineDestinations)
      .leftJoin(recipientLineDestinations, eq(recipientLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.recipientProfileId && existing.recipientProfileId !== recipientId) {
      return failure(context, 'This LINE ID is already linked to another member.', 409);
    }
    const previousManual = await database.select({ id: lineDestinations.id }).from(lineDestinations)
      .innerJoin(recipientLineDestinations, eq(recipientLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(
        eq(recipientLineDestinations.recipientProfileId, recipientId),
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
    if (!existing?.recipientProfileId) {
      await database.insert(recipientLineDestinations).values({
        recipientProfileId: recipientId,
        lineDestinationId,
        createdAt: timestamp,
      }).run();
    }
    return json(context, {
      id: lineDestinationId,
      destinationId: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', destinationId),
      displayName,
      kind,
      status: 'discovered' as const,
      source: existing?.source ?? 'manual',
    }, existing ? 200 : 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be saved.', 409);
  }
});

app.delete('/api/organizations/:organizationId/recipients/:recipientId/line-destination/:lineDestinationId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'LINE Destinations can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const recipientId = context.req.param('recipientId');
    const lineDestinationId = context.req.param('lineDestinationId');
    const database = drizzleOrganizationDatabase(access.database);
    const link = await database.select({
      lineDestinationId: recipientLineDestinations.lineDestinationId,
      source: lineDestinations.source,
    }).from(recipientLineDestinations)
      .innerJoin(lineDestinations, eq(lineDestinations.id, recipientLineDestinations.lineDestinationId))
      .where(and(
        eq(recipientLineDestinations.recipientProfileId, recipientId),
        eq(recipientLineDestinations.lineDestinationId, lineDestinationId),
      )).get();
    if (!link) return failure(context, 'LINE Destination link was not found.', 404);
    if (link.source === 'manual') {
      await database.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    } else {
      await database.delete(recipientLineDestinations).where(and(
        eq(recipientLineDestinations.recipientProfileId, recipientId),
        eq(recipientLineDestinations.lineDestinationId, lineDestinationId),
      )).run();
    }
    return json(context, { id: lineDestinationId, unlinked: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be unlinked.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/import/preview', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient imports can only be previewed by an Owner, Admin, or Operator.', 403);
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    return json(context, previewRecipientCsv(input.csv));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient import could not be previewed.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/import', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient imports can only be confirmed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    const preview = previewRecipientCsv(input.csv);
    const timestamp = now();
    const database = drizzleOrganizationDatabase(access.database);
    const writes = await Promise.all(preview.accepted.map((recipient) => database.insert(recipientProfiles).values({
      id: crypto.randomUUID(),
      organizationId: access.organization.id,
      name: recipient.name,
      email: recipient.email,
      state: 'active',
      tags: '[]',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning({ id: recipientProfiles.id }).get()));
    const imported = writes.filter(Boolean).length;
    return json(context, { imported, duplicates: preview.duplicates, invalid: preview.invalid }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient import could not be completed.', 409);
  }
});

app.get('/api/organizations/:organizationId/dashboard', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const database = drizzleOrganizationDatabase(access.database);
    const [rules, events, jobs, exceptions, connection] = await Promise.all([
      database.select({ value: count() }).from(organizationRules).where(eq(organizationRules.status, 'active')).get(),
      database.select({ value: count() }).from(organizationEvents).where(and(eq(organizationEvents.status, 'scheduled'), gte(organizationEvents.startsAt, now()))).get(),
      database.select({ value: count() }).from(organizationJobs).where(inArray(organizationJobs.state, ['pending', 'running'])).get(),
      database.select({ value: count() }).from(organizationExceptions).where(eq(organizationExceptions.state, 'open')).get(),
      database.select({ value: max(googleConnections.updatedAt) }).from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get(),
    ]);
    return json(context, {
      activeRules: rules?.value ?? 0,
      upcomingEvents: events?.value ?? 0,
      pendingJobs: jobs?.value ?? 0,
      exceptions: exceptions?.value ?? 0,
      lastSyncedAt: connection?.value ?? null,
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Dashboard could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/members/:identityId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner') return failure(context, 'Only an Owner can change member roles.', 403);
    const input = await context.req.json<{ role?: string; state?: string }>();
    if (input.role !== undefined && !['owner', 'admin', 'operator', 'viewer'].includes(input.role)) return failure(context, 'Unsupported member role.');
    if (input.state !== undefined && !['active', 'suspended'].includes(input.state)) return failure(context, 'Unsupported member state.');
    if (input.role === undefined && input.state === undefined) return failure(context, 'A member role or state is required.');
    const updates: Partial<typeof members.$inferInsert> = { updatedAt: now() };
    if (input.role !== undefined) updates.role = input.role as 'owner' | 'admin' | 'operator' | 'viewer';
    if (input.state !== undefined) updates.state = input.state as 'active' | 'suspended';
    const updated = await drizzleControlDatabase(context.env.CONTROL_DB).update(members).set(updates).where(and(
      eq(members.organizationId, access.organization.id),
      eq(members.identityId, context.req.param('identityId')),
    )).returning({ identityId: members.identityId }).get();
    if (!updated) return failure(context, 'Member was not found.', 404);
    return json(context, { identityId: context.req.param('identityId'), ...(input.role === undefined ? {} : { role: input.role }), ...(input.state === undefined ? {} : { state: input.state }) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member could not be updated.', 409);
  }
});

app.put('/api/organizations/:organizationId/task-roles/:role', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Operational task roles can only be changed by an Owner or Admin.', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const role = context.req.param('role');
    if (role !== 'organizer' && role !== 'treasurer') return failure(context, 'Unsupported operational task role.');
    const input = await context.req.json<{ identityId?: string }>();
    if (!input.identityId) return failure(context, 'An active Organization member is required.');
    const member = await drizzleControlDatabase(context.env.CONTROL_DB).select({
      identityId: members.identityId,
      displayName: identities.displayName,
    }).from(members).innerJoin(identities, eq(identities.id, members.identityId)).where(and(
      eq(members.organizationId, organizationId),
      eq(members.identityId, input.identityId),
      eq(members.state, 'active'),
    )).get();
    if (!member) return failure(context, 'Task roles can only be assigned to an active Organization member.', 409);
    await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).assignRole({
      role: role as OperationalTaskRole,
      identityId: member.identityId,
      displayName: member.displayName,
    });
    return json(context, { role, ...member });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational task role could not be saved.', 409);
  }
});

app.get('/api/organizations/:organizationId/task-roles', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const membersForTasks = await drizzleControlDatabase(context.env.CONTROL_DB).select({
      identityId: members.identityId,
      displayName: identities.displayName,
    }).from(members).innerJoin(identities, eq(identities.id, members.identityId)).where(and(
      eq(members.organizationId, organizationId),
      eq(members.state, 'active'),
    )).all();
    const assignments = await drizzleOrganizationDatabase(access.database).select().from(taskRoleAssignments).all();
    return json(context, { members: membersForTasks, assignments });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operational task roles could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/tasks', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const assigneeIdentityId = context.req.query('assignee')?.trim();
    const event = context.req.query('event')?.trim();
    return json(context, await createTaskWorkflow(drizzleOrganizationDatabase(access.database)).list({
      ...(assigneeIdentityId ? { assigneeIdentityId } : {}),
      ...(event ? { event } : {}),
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Tasks could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/tasks/:taskId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role === 'viewer') return failure(context, 'Viewers cannot update Tasks.', 403);
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
    if (access.role !== 'owner') return failure(context, 'Only an Owner can request recovery.', 403);
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

app.post('/api/organizations/:organizationId/recovery-requests/:requestId/execute', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'operator') return failure(context, 'Only an Operator can execute an Owner recovery request.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const control = drizzleControlDatabase(context.env.CONTROL_DB);
    const request = await control.select({
      id: recoveryRequests.id,
      idempotencyKey: recoveryRequests.idempotencyKey,
    }).from(recoveryRequests).where(and(
      eq(recoveryRequests.id, context.req.param('requestId')),
      eq(recoveryRequests.organizationId, access.organization.id),
      eq(recoveryRequests.state, 'requested'),
    )).get();
    if (!request) return failure(context, 'Recovery request was not found or is no longer pending.', 404);
    const claimed = await control.update(recoveryRequests).set({
      state: 'executing',
      executedByIdentityId: access.session.identity_id,
    }).where(and(eq(recoveryRequests.id, request.id), eq(recoveryRequests.state, 'requested')))
      .returning({ id: recoveryRequests.id }).get();
    if (!claimed) return failure(context, 'Recovery request is already being executed.', 409);
    try {
      const organizationKey = await organizationKeyForRequest(context.env, access.organization.id);
      const receipt = await readRecoveryReceipt({ bucket: context.env.RECOVERY_RECEIPTS, organizationKey, organizationId: access.organization.id, idempotencyKey: request.idempotencyKey });
      if (!receipt) throw new Error('The requested recovery receipt no longer exists.');
      await restoreDeliveryRecordFromReceipt(access.database, receipt);
      await control.update(recoveryRequests).set({ state: 'completed', executedAt: now(), errorMessage: null })
        .where(eq(recoveryRequests.id, request.id)).run();
      return json(context, { id: request.id, state: 'completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery execution failed.';
      await control.update(recoveryRequests).set({ state: 'failed', errorMessage: message, executedAt: now() })
        .where(eq(recoveryRequests.id, request.id)).run();
      return failure(context, message, 409);
    }
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery execution could not be started.', 409);
  }
});

app.post('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'Attendance link was not found.', 404);
    const input = await context.req.json<{ eventId?: string; status?: string; comment?: string }>();
    if (!input.eventId || !['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) return failure(context, 'A response status is required.');
    const comment = input.comment?.trim() ?? '';
    if (comment.length > 1_000) return failure(context, 'Attendance comment is too long.');
    const organizationDb = drizzleOrganizationDatabase(database);
    const link = await organizationDb.select({
      linkEventId: attendance.eventId,
      revokedAt: attendance.revokedAt,
      attendanceDeadline: organizationEvents.attendanceDeadline,
    }).from(attendance).innerJoin(organizationEvents, eq(organizationEvents.id, attendance.eventId))
      .where(eq(attendance.token, context.req.param('token'))).get();
    if (!link || !link.attendanceDeadline || !canUpdateAttendance({
      eventId: input.eventId,
      linkEventId: link.linkEventId,
      revokedAt: link.revokedAt,
      deadline: link.attendanceDeadline,
      now: now(),
    })) return failure(context, 'Attendance link is no longer available.', 410);
    await organizationDb.update(attendance).set({
      status: input.status as 'unanswered' | 'attending' | 'not_attending',
      comment,
      updatedAt: now(),
    }).where(and(eq(attendance.token, context.req.param('token')), eq(attendance.eventId, input.eventId))).run();
    return json(context, { eventId: input.eventId, status: input.status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance response could not be saved.', 409);
  }
});

app.get('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  const database = await activeOrganizationDatabase(context.env, context.req.param('organizationId'));
  if (!database) return failure(context, 'Attendance link was not found.', 404);
  const row = await drizzleOrganizationDatabase(database).select({
    eventId: attendance.eventId,
    status: attendance.status,
    comment: attendance.comment,
  }).from(attendance).where(and(
    eq(attendance.token, context.req.param('token')),
    isNull(attendance.revokedAt),
  )).get();
  if (!row) return failure(context, 'Attendance link was not found.', 404);
  return json(context, row);
});

app.patch('/api/organizations/:organizationId/events/:eventId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Events can only be changed by an Owner, Admin, or Operator.', 403);
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

app.post('/api/organizations/:organizationId/events/:eventId/attendance-links', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Attendance links can only be issued by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ recipientItemId?: string }>();
    if (!input.recipientItemId?.trim()) return failure(context, 'A Recipient is required.');
    const eventId = context.req.param('eventId');
    const token = randomToken(32);
    const timestamp = now();
    await drizzleOrganizationDatabase(access.database).insert(attendance).values({
      eventId,
      recipientItemId: input.recipientItemId.trim(),
      status: 'unanswered',
      comment: '',
      token,
      revokedAt: null,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: [attendance.eventId, attendance.recipientItemId],
      set: { token, status: 'unanswered', comment: '', revokedAt: null, updatedAt: timestamp },
    }).run();
    return json(context, {
      eventId,
      recipientItemId: input.recipientItemId.trim(),
      token,
      attendanceUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.organization.id)}/attendance/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance link could not be issued.', 409);
  }
});

app.post('/api/organizations/:organizationId/events/:eventId/recipient-snapshots', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient snapshots can only be created by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ recipientProfileIds?: unknown }>();
    if (!Array.isArray(input.recipientProfileIds) || !input.recipientProfileIds.length || input.recipientProfileIds.some((id) => typeof id !== 'string' || !id.trim())) return failure(context, 'At least one Recipient Profile is required.');
    const recipientProfileIds = [...new Set(input.recipientProfileIds.map((id) => id.trim()))];
    const database = drizzleOrganizationDatabase(access.database);
    const recipients = await database.select({
      id: recipientProfiles.id,
      name: recipientProfiles.name,
      email: recipientProfiles.email,
    }).from(recipientProfiles).where(and(
      inArray(recipientProfiles.id, recipientProfileIds),
      eq(recipientProfiles.state, 'active'),
    )).all();
    if (recipients.length !== recipientProfileIds.length) return failure(context, 'One or more active Recipient Profiles were not found.', 404);
    const timestamp = now();
    await Promise.all(recipients.map((recipient) => database.insert(eventRecipients).values({
      eventId: context.req.param('eventId'),
      recipientProfileId: recipient.id,
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
      channel: row.channel,
      destination: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.destination),
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
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Only an Owner, Admin, or Operator can change Exceptions.', 403);
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
    await Promise.all(destinations.map(async (destination) => {
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
    return json(context, { discovered: destinations.length });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE webhook could not be processed.', 400);
  }
});

app.post('/api/public/organizations/:organizationId/line-links/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'Recipient Link was not found.', 404);
    const organizationDb = drizzleOrganizationDatabase(database);
    const input = await context.req.json<{ destinationId?: string }>();
    if (!input.destinationId?.trim()) return failure(context, 'A discovered LINE Destination is required.');
    const link = await organizationDb.select({
      recipientProfileId: recipientLinkTokens.recipientProfileId,
    }).from(recipientLinkTokens).where(and(
      eq(recipientLinkTokens.token, context.req.param('token')),
      isNull(recipientLinkTokens.usedAt),
      gt(recipientLinkTokens.expiresAt, now()),
    )).get();
    if (!link) return failure(context, 'Recipient Link has expired or was already used.', 410);
    const destination = await organizationDb.select({ id: lineDestinations.id }).from(lineDestinations).where(and(
      eq(lineDestinations.destinationId, input.destinationId.trim()),
      eq(lineDestinations.status, 'discovered'),
    )).limit(1).get();
    if (!destination) return failure(context, 'LINE Destination was not found.', 404);
    const timestamp = now();
    await organizationDb.insert(recipientLineDestinations).values({
      recipientProfileId: link.recipientProfileId,
      lineDestinationId: destination.id,
      createdAt: timestamp,
    }).onConflictDoNothing().run();
    const consumed = await organizationDb.update(recipientLinkTokens).set({ usedAt: timestamp }).where(and(
      eq(recipientLinkTokens.token, context.req.param('token')),
      isNull(recipientLinkTokens.usedAt),
    )).returning({ token: recipientLinkTokens.token }).get();
    if (!consumed) return failure(context, 'Recipient Link was already used.', 410);
    return json(context, { recipientProfileId: link.recipientProfileId, destinationId: input.destinationId.trim() });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Link could not be consumed.', 409);
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
      role: members.role,
    }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(and(
      eq(members.identityId, session.identity_id),
      eq(members.organizationId, organizationId),
      eq(members.state, 'active'),
    )).get();
    if (!membership || membership.role !== 'owner') return failure(context, 'Only an Owner can suspend or resume an Organization.', 403);
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
