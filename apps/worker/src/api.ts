import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, max, ne } from 'drizzle-orm';

import { canUpdateAttendance, discoveredLineDestinations, displayLineDestinationId, verifyLineWebhookSignature } from '@mail/domain';

import { createAutomation } from './automation';
import { LEGACY_AI_BASE_URL } from './ai';
import { productionProviders } from './providers';
import { decrypt, encrypt } from './cryptography';
import { createDatabaseAccess } from './database-access';
import { randomToken } from './encoding';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt } from './recovery-receipts';
import { affiliationCounts } from './guests';
import { exportContactCsv, previewContactCsv } from './roster';
import { failure, json } from './response';
import { entryRoutes, oauthRoutes } from './routes/entry';
import { automationRoutes } from './routes/automation';
import { portalRoutes } from './routes/portal';
import { createRequestContext } from './routes/request-context';
import { typedListRoutes } from './routes/typed-lists';
import { SchemaReadinessError } from './schema-lifecycle';
import type { Bindings, ConnectionRow, SessionRow } from './types';
import type { CipherEnvelope } from './cryptography';
import { normalizedAiBaseUrl, openAiChatCompletionsUrl, type EventDetails, type MailExtraction, type TaskDetails } from './event-details';
import { readAgentRunTranscript } from './agent-runs';
import { resolveChatTools, runChatTurn, type ChatModelPort } from './chat';
import {
  chatHistory,
  chatInternalHandlers,
  closeChatTurn,
  deleteChatServer,
  ensureChatConversation,
  listChatConversations,
  listChatServers,
  openChatTurn,
  readChatTurns,
  saveChatServer,
} from './chat-store';
import { completeChatTurn } from './chat-model';
import { generateAccessToken, accessTokenHash, presentedToken } from './access-token';
import { grantedServerTools, handleMcpServerRequest, MCP_SERVER_TOOLS, type JsonRpcRequest } from './mcp-server';
import { channelCredentials, LINE_BATCH_LIMIT, reachableContacts, sendOnChannel } from './channel';
import { callMcpTool, listMcpTools } from './mcp';
import {
  admitAccessTokenCall,
  authenticateAccessToken,
  mcpServerPorts,
  publishedPrompts,
  suppressionPort,
} from './mcp-server-store';
import { SUPPRESSION_WINDOWS, type SuppressionWindow } from './suppression';
import { parseSchedule, nextScheduledRun } from './schedule';
import { discordHandleFromInteraction, discordReply, verifyDiscordSignature, type DiscordInteraction } from './discord';
import { channelHandles } from './storage/account-schema';
import { CHAT_INTERNAL_TOOLS, INTERNAL_WRITE_TOOLS } from './chat';
import { automationRuns, automations as accountAutomations, automationTools } from './storage/account-schema';
import { accessTokens, accessTokenTools, contactListMembers, contactLists } from './storage/account-schema';
import { mcpServers } from './storage/account-schema';
import { createTaskWorkflow } from './tasks';
import { ruleExecutionFor } from './execution';
import { applyPreset, availablePresets, PresetConfigurationConflictError } from './presets';
import { controlDatabase as drizzleControlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { createAccountStore } from './storage/account-store';
import { accountIdentities, identities, accounts, recoveryRequests } from './storage/control-schema';
import {
  agentRuleRevisions,
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRules,
  agentRuns,
  attendance,
  automationWarnings,
  connections as accountConnections,
  deliveries as accountDeliveries,
  eventOverrides,
  eventRecipients,
  events as accountEvents,
  guestRegistrations,
  exceptions as accountExceptions,
  googleConnections,
  jobs as accountJobs,
  lineDestinations,
  listItems,
  lists as accountLists,
  contactLineDestinations,
  contactLinkTokens,
  contacts,
  portalInvitations,
  ruleRevisions,
  rulePermittedLineLists,
  rulePermittedRecipientLists,
  rules as accountRules,
  promptRevisions,
  prompts,
} from './storage/account-schema';

const RECIPIENT_LINK_WINDOW_MS = 15 * 60 * 1_000;
const LINE_DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
type AccountCredential = Record<string, string>;

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

app.onError((error, context) => {
  const requestId = context.req.header('cf-ray') ?? crypto.randomUUID();
  if (error instanceof SchemaReadinessError) {
    console.error(JSON.stringify({
      event: 'schema_not_ready',
      requestId,
      category: error.category,
      databaseKind: error.kind,
      databaseId: error.databaseId,
      bindingName: error.bindingName,
      currentMigration: error.currentMigration,
      expectedMigration: error.expectedMigration,
      message: error.message,
    }));
    return context.json({
      error: {
        code: 'schema_not_ready',
        message: error.message,
        category: error.category,
        databaseKind: error.kind,
        databaseId: error.databaseId,
        bindingName: error.bindingName,
        currentMigration: error.currentMigration,
        expectedMigration: error.expectedMigration,
        requestId,
      },
    }, 503);
  }
  console.error(error);
  return failure(context, 'サーバーで予期しないエラーが発生しました。', 500);
});

app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));
app.use('*', async (context, next) => {
  await createDatabaseAccess(context.env).open({ kind: 'control' });
  await next();
});
app.route('/api', entryRoutes);
app.route('/api', automationRoutes);
app.route('/api', typedListRoutes);
app.route('/api', portalRoutes);
app.route('/', oauthRoutes);

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const accountForRequest = (request: Request, env: Bindings, accountId: string) =>
  createRequestContext(request, env).account(accountId);

const accountKeyForRequest = (env: Bindings, accountId: string) =>
  createRequestContext(new Request('https://request-context.invalid'), env).accountKey(accountId);

const activeAccountDatabase = (env: Bindings, accountId: string) =>
  createRequestContext(new Request('https://request-context.invalid'), env).activeAccountDatabase(accountId);

const mailTestContext = (accountId: string): string => `mail-test-preview:${accountId}`;
const MAIL_TEST_WINDOW_MS = 15 * 60 * 1_000;

app.get('/api/presets', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
  return json(context, availablePresets().map(({ id, name, description }) => ({ id, name, description })));
});

app.post('/api/organizations/:accountId/presets/:presetId/apply', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, 'Account database is not available.', 503);
    const input = await context.req.json<{ conflictPolicy?: unknown }>();
    if (input.conflictPolicy !== undefined && input.conflictPolicy !== 'duplicate') return failure(context, 'Unsupported Preset conflict policy.');
    const applied = await applyPreset(
      drizzleAccountDatabase(access.database),
      access.account.id,
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

const mailTestRefreshContext = (accountId: string): string => `mail-test-refresh:${accountId}`;
const MAIL_TEST_TOKEN_LIMIT = 60_000;

const refreshToken = async (
  env: Bindings,
  accountId: string,
  confirmation: MailTestRefreshConfirmation,
): Promise<string> => JSON.stringify(await encrypt(
  JSON.stringify(confirmation),
  await accountKeyForRequest(env, accountId),
  mailTestRefreshContext(accountId),
));

const connectionContext = (accountId: string, kind: 'line' | 'ai'): string => `organization-connection:${accountId}:${kind}`;
const lineWebhookUrl = (appUrl: string, accountId: string): string =>
  `${appUrl.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/line/webhook`;

const lineDestinationDisplayName = async (
  credential: AccountCredential,
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
  accountId: string,
  kind: 'line' | 'ai',
): Promise<AccountCredential> => {
  if (!row) return {};
  return JSON.parse(await decrypt(JSON.parse(row.credential), key, connectionContext(accountId, kind))) as AccountCredential;
};

const saveConnectionCredential = async (input: {
  database: D1Database;
  existing: ConnectionRow | undefined;
  accountKey: CryptoKey;
  accountId: string;
  kind: 'line' | 'ai';
  label: string;
  credential: AccountCredential;
}): Promise<void> => {
  const db = drizzleAccountDatabase(input.database);
  const timestamp = now();
  const envelope = await encrypt(
    JSON.stringify(input.credential),
    input.accountKey,
    connectionContext(input.accountId, input.kind),
  );
  const storedCredential = JSON.stringify(envelope);
  if (input.existing) {
    await db.update(accountConnections).set({
      label: input.label,
      credential: storedCredential,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(accountConnections.id, input.existing.id)).run();
    return;
  }
  await db.insert(accountConnections).values({
    id: crypto.randomUUID(),
    kind: input.kind,
    label: input.label,
    credential: storedCredential,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
};

const connectionView = (line: AccountCredential, ai: AccountCredential) => ({
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

app.get('/api/organizations/:accountId/connections', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const rows = await drizzleAccountDatabase(access.database).select().from(accountConnections)
      .where(and(inArray(accountConnections.kind, ['line', 'ai']), eq(accountConnections.status, 'active'))).all();
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const line = rows.find((row) => row.kind === 'line');
    const ai = rows.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(line ?? null, accountKey, accountId, 'line'),
      connectionCredential(ai ?? null, accountKey, accountId, 'ai'),
    ]);
    const view = connectionView(lineCredential, aiCredential);
    return json(context, {
      accountId,
      accountName: access.account.name,
      line: { ...view.line, webhookUrl: lineWebhookUrl(context.env.APP_URL, accountId) },
      ai: view.ai,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を取得できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:accountId/connections/line', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。LINE接続は保存されていません。', 503);
    const db = drizzleAccountDatabase(access.database);
    const input = await context.req.json<LineConnectionInput>();
    const existing = await db.select().from(accountConnections)
      .where(and(eq(accountConnections.kind, 'line'), eq(accountConnections.status, 'active'))).limit(1).get();
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const current = await connectionCredential(existing ?? null, accountKey, accountId, 'line');
    const next: AccountCredential = { ...current, ...input };
    if (!next.channelAccessToken || !next.channelSecret) return failure(context, 'LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    await saveConnectionCredential({ database: access.database, existing, accountKey, accountId, kind: 'line', label: 'LINE Messaging API', credential: next });
    return json(context, {
      ...connectionView(next, {}).line,
      webhookUrl: lineWebhookUrl(context.env.APP_URL, accountId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LINE接続を保存できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:accountId/connections/ai', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。AI接続は保存されていません。', 503);
    const db = drizzleAccountDatabase(access.database);
    const input = await context.req.json<AiConnectionInput>();
    const existing = await db.select().from(accountConnections)
      .where(and(eq(accountConnections.kind, 'ai'), eq(accountConnections.status, 'active'))).limit(1).get();
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const current = await connectionCredential(existing ?? null, accountKey, accountId, 'ai');
    const next: AccountCredential = { ...current, ...input };
    const baseUrl = normalizedAiBaseUrl(next.baseUrl);
    const model = next.model?.trim();
    if (!next.apiKey || !model || !baseUrl) return failure(context, 'OpenAI 互換 API の Base URL、model、API キーを入力してください。');
    if (model.length > 200) return failure(context, 'model は 200 文字以内で入力してください。');
    next.provider = 'OpenAI-compatible API';
    next.model = model;
    next.baseUrl = baseUrl;
    await saveConnectionCredential({ database: access.database, existing, accountKey, accountId, kind: 'ai', label: 'OpenAI 互換 API', credential: next });
    return json(context, connectionView({}, next).ai);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI接続を保存できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.post('/api/organizations/:accountId/connections/ai/test', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const input = await context.req.json<{ prompt?: string }>();
    const prompt = input.prompt?.trim() ?? '';
    if (!prompt || prompt.length > 10_000) return failure(context, 'テスト用の質問は 1〜10,000 文字で入力してください。');
    const existing = await drizzleAccountDatabase(access.database).select().from(accountConnections)
      .where(and(eq(accountConnections.kind, 'ai'), eq(accountConnections.status, 'active'))).limit(1).get();
    if (!existing) return failure(context, 'OpenAI 互換 API を設定してください。', 409);
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const credential = await connectionCredential(existing, accountKey, accountId, 'ai');
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

app.post('/api/organizations/:accountId/mail-tests/search', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ subject?: string }>();
    const subject = input.subject?.trim() ?? '';
    if (!subject || subject.length > 300) return failure(context, '件名は 1〜300 文字で入力してください。');
    const automation = await createAccountStore(drizzleAccountDatabase(access.database)).currentAutomation();
    if (!automation) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { accountEmail: automation.email, messages: await createAutomation(context.env, providers).mailboxTest.search({ accountId, database: access.database, subject }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gmail の検索に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Returns the exact, redacted OpenAI-compatible payload without calling the AI API. */
app.post('/api/organizations/:accountId/mail-tests/:messageId/ai-request', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await createAutomation(context.env, providers).mailboxTest.readSource({ accountId, database: access.database, messageId });
    const request = await createAutomation(context.env, providers).mailboxTest.previewAiRequest({
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

/** Draft Rule Preview is a Rule Runs concern, separate from the permanent Mailbox Test. */
app.post('/api/organizations/:accountId/mail-tests/:messageId/draft-preview', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const input = await context.req.json<{ ruleId?: string }>().catch((): { ruleId?: string } => ({}));
    if (!input.ruleId) return failure(context, 'Draft Schema Rule を選択してください。');
    const { source, rule, extraction } = await createAutomation(context.env, providers).ruleRuns.previewDraft({
      accountId,
      database: access.database,
      messageId,
      ruleId: input.ruleId,
    });
    const confirmation: MailTestConfirmation = {
      purpose: 'draft_rule_preview',
      messageId,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      extraction,
      expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
    };
    const token = JSON.stringify(await encrypt(JSON.stringify(confirmation), await accountKeyForRequest(context.env, accountId), mailTestContext(accountId)));
    return json(context, {
      id: source.id,
      subject: source.subject,
      sender: source.sender,
      selectedRule: { id: rule.id, revision: rule.revision },
      ...extraction,
      confirmationToken: token,
      expiresAt: confirmation.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Draft Rule Preview に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : message.includes('Selection Policy') ? 409 : 500);
  }
});

app.post('/api/organizations/:accountId/mail-tests/:messageId/preview', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const { source, rule, extraction } = await createAutomation(context.env, providers).mailboxTest.preview({ accountId, database: access.database, messageId });
    const confirmation: MailTestConfirmation = {
      purpose: 'mailbox_test',
      messageId,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      extraction,
      expiresAt: expiresIn(MAIL_TEST_WINDOW_MS),
    };
    const token = JSON.stringify(await encrypt(JSON.stringify(confirmation), await accountKeyForRequest(context.env, accountId), mailTestContext(accountId)));
    return json(context, {
      id: source.id,
      subject: source.subject,
      sender: source.sender,
      selectedRule: { id: rule.id, revision: rule.revision },
      ...extraction,
      confirmationToken: token,
      expiresAt: confirmation.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI による予定の抽出に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : message.includes('Primary Rule') ? 409 : 500);
  }
});

app.post('/api/organizations/:accountId/mail-tests/calendar', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) {
      return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    }
    const confirmation = await confirmedExtraction(context.env, accountId, input.confirmationToken);
    if (!confirmation) return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    return json(context, await createAutomation(context.env, providers).mailboxTest.createCalendarEvents({
      accountId,
      database: access.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    }), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google Calendar へのテスト予定作成に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:accountId/mail-tests/rule-run', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string; ruleId?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    if (!input.ruleId) return failure(context, 'Draft Schema Rule を選択してください。');
    const confirmation = JSON.parse(await decrypt(JSON.parse(input.confirmationToken) as CipherEnvelope, await accountKeyForRequest(context.env, accountId), mailTestContext(accountId))) as Partial<MailTestConfirmation>;
    if (confirmation.purpose !== 'draft_rule_preview' || typeof confirmation.messageId !== 'string' || typeof confirmation.ruleRevision !== 'number'
      || !isMailExtraction(confirmation.extraction) || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) {
      return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    }
    if (confirmation.ruleId !== input.ruleId) return failure(context, '確認した Rule Revision と異なります。', 409);
    return json(context, await createAutomation(context.env, providers).ruleRuns.startDraft({
      accountId,
      database: access.database,
      ruleId: input.ruleId,
      ruleRevision: confirmation.ruleRevision,
      messageId: confirmation.messageId,
      extraction: confirmation.extraction,
    }), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Draft Rule Run を開始できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Reads the confirmed extraction back out of a Mailbox Test preview token. */
const confirmedExtraction = async (
  env: Bindings,
  accountId: string,
  token: string,
): Promise<MailTestConfirmation | null> => {
  const confirmation = JSON.parse(await decrypt(
    JSON.parse(token) as CipherEnvelope,
    await accountKeyForRequest(env, accountId),
    mailTestContext(accountId),
  )) as Partial<MailTestConfirmation>;
  if (confirmation.purpose !== 'mailbox_test' || typeof confirmation.messageId !== 'string'
    || typeof confirmation.ruleId !== 'string' || typeof confirmation.ruleRevision !== 'number'
    || !isMailExtraction(confirmation.extraction)
    || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) return null;
  return confirmation as MailTestConfirmation;
};

/** Prepares the correspondence request against the Scheduled Events this message already produced. */
app.post('/api/organizations/:accountId/mail-tests/:messageId/refresh-request', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = await confirmedExtraction(context.env, accountId, input.confirmationToken);
    if (!confirmation) return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    if (confirmation.messageId !== context.req.param('messageId')) return failure(context, '確認用トークンが別のメールのものです。', 409);
    return json(context, await createAutomation(context.env, providers).mailboxTest.previewRefreshRequest({
      accountId,
      database: access.database,
      messageId: confirmation.messageId,
      events: confirmation.extraction.events,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定の照合準備に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Runs the correspondence decision and returns the plan an AccountIdentity approves. */
app.post('/api/organizations/:accountId/mail-tests/:messageId/refresh-plan', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = await confirmedExtraction(context.env, accountId, input.confirmationToken);
    if (!confirmation) return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    if (confirmation.messageId !== context.req.param('messageId')) return failure(context, '確認用トークンが別のメールのものです。', 409);
    const plan = await createAutomation(context.env, providers).mailboxTest.planRefresh({
      accountId,
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
      confirmationToken: await refreshToken(context.env, accountId, approvable),
      expiresAt: approvable.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定との照合に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

/** Applies the approved Event Refresh, and re-offers anything the Calendar changed underneath it. */
app.post('/api/organizations/:accountId/mail-tests/refresh', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string; candidateIndexes?: unknown }>();
    if (!input.confirmationToken || input.confirmationToken.length > MAIL_TEST_TOKEN_LIMIT) return failure(context, '確認用トークンがありません。先に既存予定と照合してください。');
    const selected = Array.isArray(input.candidateIndexes) && input.candidateIndexes.every((value) => typeof value === 'number')
      ? new Set(input.candidateIndexes as number[])
      : null;
    if (!selected?.size) return failure(context, '更新する予定を選択してください。');
    const confirmation = JSON.parse(await decrypt(
      JSON.parse(input.confirmationToken) as CipherEnvelope,
      await accountKeyForRequest(context.env, accountId),
      mailTestRefreshContext(accountId),
    )) as unknown;
    if (!isRefreshConfirmation(confirmation) || Date.parse(confirmation.expiresAt) <= Date.now()) {
      return failure(context, '照合結果の有効期限が切れました。もう一度既存予定と照合してください。', 409);
    }
    const entries = confirmation.entries.filter((entry) => selected.has(entry.candidateIndex));
    if (!entries.length) return failure(context, '選択された予定が照合結果に含まれていません。', 409);
    const outcome = await createAutomation(context.env, providers).mailboxTest.applyRefresh({
      accountId,
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
      confirmationToken: await refreshToken(context.env, accountId, retry),
      expiresAt: retry.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '既存予定の更新に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.get('/api/organizations/:accountId/lists', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const database = drizzleAccountDatabase(access.database);
    const rows = await database.select().from(accountLists).orderBy(asc(accountLists.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      accountId: access.account.id,
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

app.post('/api/organizations/:accountId/lists', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ kind?: string; name?: string; description?: string }>();
    const kind = input.kind?.trim() as 'source' | 'recipient' | 'line' | undefined;
    const name = input.name?.trim();
    if (!kind || !['source', 'recipient', 'line'].includes(kind)) return failure(context, 'Unsupported Typed List kind.');
    if (!name) return failure(context, 'Typed List name is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const description = input.description?.trim() ?? '';
    await drizzleAccountDatabase(access.database).insert(accountLists).values({
      id,
      accountId: access.account.id,
      kind,
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return json(context, {
      id,
      accountId: access.account.id,
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

app.post('/api/organizations/:accountId/lists/:listId/items', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ value?: string; label?: string }>();
    const value = input.value?.trim();
    if (!value) return failure(context, 'List Item value is required.');
    const id = crypto.randomUUID();
    await drizzleAccountDatabase(access.database).insert(listItems).values({
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

app.patch('/api/organizations/:accountId/lists/:listId/items/:itemId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const updated = await drizzleAccountDatabase(access.database).update(listItems)
      .set({ enabled: input.enabled })
      .where(and(eq(listItems.id, context.req.param('itemId')), eq(listItems.listId, context.req.param('listId'))))
      .returning({ id: listItems.id }).get();
    if (!updated) return failure(context, 'List Item was not found.', 404);
    return json(context, { id: context.req.param('itemId'), enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be updated.', 409);
  }
});

app.get('/api/organizations/:accountId/prompts', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(prompts)
      .orderBy(asc(prompts.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
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

app.post('/api/organizations/:accountId/prompts', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; instructions?: string }>();
    const name = input.name?.trim() ?? '';
    const instructions = input.instructions?.trim() ?? '';
    if (!name || name.length > 100) return failure(context, 'A Prompt name of at most 100 characters is required.');
    if (!instructions || instructions.length > 100_000) return failure(context, 'Prompt instructions of at most 100000 characters are required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const database = drizzleAccountDatabase(access.database);
    await database.batch([
      database.insert(prompts).values({ id, accountId: access.account.id, name, instructions, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
      database.insert(promptRevisions).values({ promptId: id, revision: 1, instructions, createdAt: timestamp }),
    ]);
    return json(context, { id, accountId: access.account.id, name, instructions, revision: 1, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompt could not be created.', 409);
  }
});

app.patch('/api/organizations/:accountId/prompts/:promptId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; instructions?: string }>();
    const name = input.name?.trim();
    const instructions = input.instructions?.trim();
    if (name === undefined && instructions === undefined) return failure(context, 'A Prompt name or instructions is required.');
    if (name !== undefined && (!name || name.length > 100)) return failure(context, 'A Prompt name of at most 100 characters is required.');
    if (instructions !== undefined && (!instructions || instructions.length > 100_000)) return failure(context, 'Prompt instructions of at most 100000 characters are required.');
    const database = drizzleAccountDatabase(access.database);
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

app.delete('/api/organizations/:accountId/prompts/:promptId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const promptId = context.req.param('promptId');
    const removed = await drizzleAccountDatabase(access.database).delete(prompts).where(eq(prompts.id, promptId))
      .returning({ id: prompts.id }).get();
    if (!removed) return failure(context, 'Prompt was not found.', 404);
    return json(context, { id: promptId, removed: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Prompt could not be deleted.', 409);
  }
});

const agentRuleView = (row: typeof agentRules.$inferSelect, permittedRecipientListIds: string[] = [], permittedLineListIds: string[] = []) => ({
  id: row.id,
  accountId: row.accountId,
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

app.get('/api/organizations/:accountId/agent-rules', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(agentRules)
      .orderBy(desc(agentRules.priority), asc(agentRules.name)).all();
    const database = drizzleAccountDatabase(access.database);
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

app.post('/api/organizations/:accountId/agent-rules', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; promptId?: string; state?: string; executionMode?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    const name = input.name?.trim() ?? '';
    const promptId = input.promptId?.trim() ?? '';
    const state = input.state ?? 'draft';
    if (!name || name.length > 100) return failure(context, 'An Agent Rule name of at most 100 characters is required.');
    if (!promptId) return failure(context, 'An Agent Rule Prompt is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Agent Rule State.');
    const executionMode = input.executionMode ?? 'unattended';
    if (!['read_only', 'approval', 'unattended'].includes(executionMode)) return failure(context, 'Unsupported Agent Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const database = drizzleAccountDatabase(access.database);
    const prompt = await database.select({ id: prompts.id }).from(prompts).where(and(
      eq(prompts.id, promptId),
      eq(prompts.accountId, access.account.id),
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
      const permittedLists = await database.select({ id: accountLists.id, kind: accountLists.kind }).from(accountLists).where(inArray(accountLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Account and have recipient kind.', 409);
      if (permittedLineListIds.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Account and have line kind.', 409);
    }
    await database.batch([
      database.insert(agentRules).values({ id, accountId: access.account.id, name, status: state as 'draft' | 'active' | 'suspended' | 'archived', executionMode: executionMode as 'read_only' | 'approval' | 'unattended', promptId, selectionPolicy, priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
      database.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId: id, revision: 1, promptId, selectionPolicy, executionMode: executionMode as 'read_only' | 'approval' | 'unattended', permittedRecipientListIds: JSON.stringify(permittedRecipientListIds), permittedLineListIds: JSON.stringify(permittedLineListIds), createdAt: timestamp }),
      ...permittedRecipientListIds.map((listId) => database.insert(agentRulePermittedRecipientLists).values({ agentRuleId: id, listId })),
      ...permittedLineListIds.map((listId) => database.insert(agentRulePermittedLineLists).values({ agentRuleId: id, listId })),
    ]);
    return json(context, agentRuleView({ id, accountId: access.account.id, name, status: state as 'draft' | 'active' | 'suspended' | 'archived', executionMode: executionMode as 'read_only' | 'approval' | 'unattended', promptId, selectionPolicy, priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }, permittedRecipientListIds, permittedLineListIds), 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Agent Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:accountId/agent-rules/:agentRuleId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; promptId?: string; state?: string; executionMode?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    if (input.state !== undefined && !['draft', 'active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Agent Rule State.');
    if (input.executionMode !== undefined && !['read_only', 'approval', 'unattended'].includes(input.executionMode)) return failure(context, 'Unsupported Agent Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((listId) => typeof listId !== 'string' || !listId.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((listId) => typeof listId !== 'string' || !listId.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const name = input.name?.trim();
    const promptId = input.promptId?.trim();
    if (name !== undefined && (!name || name.length > 100)) return failure(context, 'An Agent Rule name of at most 100 characters is required.');
    if (input.promptId !== undefined && !promptId) return failure(context, 'An Agent Rule Prompt is required.');
    const database = drizzleAccountDatabase(access.database);
    const id = context.req.param('agentRuleId');
    const existing = await database.select().from(agentRules).where(eq(agentRules.id, id)).get();
    if (!existing) return failure(context, 'Agent Rule was not found.', 404);
    if (promptId) {
      const prompt = await database.select({ id: prompts.id }).from(prompts).where(and(eq(prompts.id, promptId), eq(prompts.accountId, access.account.id))).get();
      if (!prompt) return failure(context, 'Agent Rule Prompt was not found.', 409);
    }
    const permittedRecipientListIds = input.permittedRecipientListIds === undefined ? undefined : [...new Set(input.permittedRecipientListIds as string[])];
    const permittedLineListIds = input.permittedLineListIds === undefined ? undefined : [...new Set(input.permittedLineListIds as string[])];
    const permittedListIds = [...(permittedRecipientListIds ?? []), ...(permittedLineListIds ?? [])];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: accountLists.id, kind: accountLists.kind }).from(accountLists).where(inArray(accountLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds?.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Account and have recipient kind.', 409);
      if (permittedLineListIds?.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Account and have line kind.', 409);
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

app.get('/api/organizations/:accountId/agent-runs', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select({
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

app.get('/api/organizations/:accountId/agent-runs/:runId/transcript', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const runId = context.req.param('runId');
    const run = await drizzleAccountDatabase(access.database).select({ id: agentRuns.id }).from(agentRuns)
      .where(eq(agentRuns.id, runId)).get();
    if (!run) return failure(context, 'Run Transcript was not found.', 404);
    const transcript = await readAgentRunTranscript({
      bucket: context.env.RECOVERY_RECEIPTS,
      accountKey: await accountKeyForRequest(context.env, access.account.id),
      accountId: access.account.id,
      runId,
    });
    if (!transcript) return failure(context, 'Run Transcript was not found.', 404);
    return json(context, transcript);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Run Transcript could not be loaded.', 403);
  }
});

const providers = productionProviders();

const ruleExecutionForRequest = (input: { env: Bindings; database: D1Database; accountId: string }) =>
  ruleExecutionFor({ ...input, providers });

app.get('/api/organizations/:accountId/rule-runs', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await ruleExecutionForRequest({
      env: context.env,
      database: access.database,
      accountId: access.account.id,
    }).list());
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule Runs could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/rule-runs/:runId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await ruleExecutionForRequest({
      env: context.env,
      database: access.database,
      accountId: access.account.id,
    }).read(context.req.param('runId')));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Rule Run could not be loaded.';
    return failure(context, message, message === 'Rule Run was not found.' ? 404 : 403);
  }
});

app.post('/api/organizations/:accountId/rule-runs/:runId/decision', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const body = await context.req.json<{ decision?: string }>();
    if (body.decision !== 'approve' && body.decision !== 'reject') return failure(context, 'Decision must be approve or reject.');
    return json(context, await ruleExecutionForRequest({
      env: context.env,
      database: access.database,
      accountId: access.account.id,
    }).decide({
      ruleRunId: context.req.param('runId'),
      decision: body.decision,
      actorIdentityId: access.session.identity_id,
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule Run could not be decided.', 409);
  }
});

app.get('/api/organizations/:accountId/rules', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(accountRules)
      .orderBy(desc(accountRules.priority), asc(accountRules.name)).all();
    const ruleIds = rows.map(({ id }) => id);
    const database = drizzleAccountDatabase(access.database);
    const [recipientLists, lineLists] = ruleIds.length ? await Promise.all([
      database.select().from(rulePermittedRecipientLists)
        .where(inArray(rulePermittedRecipientLists.ruleId, ruleIds)).all(),
      database.select().from(rulePermittedLineLists)
        .where(inArray(rulePermittedLineLists.ruleId, ruleIds)).all(),
    ]) : [[], []];
    return json(context, rows.map((row) => ({
      id: row.id,
      accountId: access.account.id,
      name: row.name,
      state: row.status,
      executionMode: row.executionMode,
      revision: row.currentRevision,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routingPolicy) as Record<string, unknown>,
      noticeContactListId: row.noticeContactListId,
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

app.post('/api/organizations/:accountId/rules', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; state?: string; executionMode?: string; selectionPolicy?: Record<string, unknown>; routingPolicy?: Record<string, unknown>; noticeContactListId?: unknown; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown; priority?: number }>();
    const name = input.name?.trim();
    const state = (input.state ?? 'draft') as 'draft' | 'active' | 'suspended' | 'archived';
    if (!name) return failure(context, 'Rule name is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Rule State.');
    const executionMode = input.executionMode ?? 'unattended';
    if (!['read_only', 'approval', 'unattended'].includes(executionMode)) return failure(context, 'Unsupported Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(input.routingPolicy ?? {});
    const permittedRecipientListIds = [...new Set((input.permittedRecipientListIds ?? []) as string[])];
    const permittedLineListIds = [...new Set((input.permittedLineListIds ?? []) as string[])];
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    const database = drizzleAccountDatabase(access.database);
    const permittedListIds = [...permittedRecipientListIds, ...permittedLineListIds];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: accountLists.id, kind: accountLists.kind })
        .from(accountLists).where(inArray(accountLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Account and have recipient kind.', 409);
      if (permittedLineListIds.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Account and have line kind.', 409);
    }
    await database.batch([
      database.insert(accountRules).values({
        id,
        accountId: access.account.id,
        name,
        status: state,
        executionMode: executionMode as 'read_only' | 'approval' | 'unattended',
        selectionPolicy,
        routingPolicy,
        noticeContactListId: typeof input.noticeContactListId === 'string' && input.noticeContactListId.trim() ? input.noticeContactListId.trim() : null,
        priority,
        currentRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      database.insert(ruleRevisions).values({
        id: crypto.randomUUID(),
        ruleId: id,
        revision: 1,
        executionMode: executionMode as 'read_only' | 'approval' | 'unattended',
        selectionPolicy,
        routingPolicy,
        createdAt: timestamp,
      }),
      ...permittedRecipientListIds.map((listId) => database.insert(rulePermittedRecipientLists).values({ ruleId: id, listId })),
      ...permittedLineListIds.map((listId) => database.insert(rulePermittedLineLists).values({ ruleId: id, listId })),
    ]);
    return json(context, { id, accountId: access.account.id, name, state, executionMode, revision: 1, selectionPolicy: input.selectionPolicy ?? {}, routingPolicy: input.routingPolicy ?? {}, noticeContactListId: typeof input.noticeContactListId === 'string' && input.noticeContactListId.trim() ? input.noticeContactListId.trim() : null, permittedRecipientListIds, permittedLineListIds, priority, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:accountId/rules/:ruleId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: unknown; state?: string; executionMode?: string; selectionPolicy?: unknown; priority?: unknown; noticeContactListId?: unknown; permittedRecipientListIds?: unknown; permittedLineListIds?: unknown }>();
    if (input.state !== undefined && !['draft', 'active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Rule State.');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) return failure(context, 'Rule name is required.');
    if (input.selectionPolicy !== undefined && (typeof input.selectionPolicy !== 'object' || input.selectionPolicy === null || Array.isArray(input.selectionPolicy))) return failure(context, 'The Selection Policy must be an object.');
    if (input.priority !== undefined && !Number.isInteger(input.priority)) return failure(context, 'The Rule priority must be a whole number.');
    if (input.executionMode !== undefined && !['read_only', 'approval', 'unattended'].includes(input.executionMode)) return failure(context, 'Unsupported Rule Execution Mode.');
    if (input.permittedRecipientListIds !== undefined && (!Array.isArray(input.permittedRecipientListIds) || input.permittedRecipientListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted Calendar Recipient List IDs must be an array of stable identifiers.');
    if (input.permittedLineListIds !== undefined && (!Array.isArray(input.permittedLineListIds) || input.permittedLineListIds.some((id) => typeof id !== 'string' || !id.trim()))) return failure(context, 'Permitted LINE Destination List IDs must be an array of stable identifiers.');
    if (input.noticeContactListId !== undefined && input.noticeContactListId !== null && typeof input.noticeContactListId !== 'string') return failure(context, 'The notice Contact List must be a stable identifier or null.');
    if (input.name === undefined && input.state === undefined && input.executionMode === undefined && input.selectionPolicy === undefined && input.priority === undefined && input.noticeContactListId === undefined && input.permittedRecipientListIds === undefined && input.permittedLineListIds === undefined) return failure(context, 'No supported Rule changes were provided.');
    const database = drizzleAccountDatabase(access.database);
    const ruleId = context.req.param('ruleId');
    const existing = await database.select().from(accountRules)
      .where(eq(accountRules.id, ruleId)).get();
    if (!existing) return failure(context, 'Rule was not found.', 404);
    const permittedRecipientListIds = input.permittedRecipientListIds === undefined
      ? undefined
      : [...new Set(input.permittedRecipientListIds as string[])];
    const permittedLineListIds = input.permittedLineListIds === undefined
      ? undefined
      : [...new Set(input.permittedLineListIds as string[])];
    const permittedListIds = [...(permittedRecipientListIds ?? []), ...(permittedLineListIds ?? [])];
    if (permittedListIds.length) {
      const permittedLists = await database.select({ id: accountLists.id, kind: accountLists.kind })
        .from(accountLists).where(inArray(accountLists.id, permittedListIds)).all();
      const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
      if (permittedRecipientListIds?.some((listId) => listKinds.get(listId) !== 'recipient')) return failure(context, 'Every permitted Calendar Recipient List must belong to the Account and have recipient kind.', 409);
      if (permittedLineListIds?.some((listId) => listKinds.get(listId) !== 'line')) return failure(context, 'Every permitted LINE Destination List must belong to the Account and have line kind.', 409);
    }
    // A Rule Revision records what a Rule does to a message it is given, which is
    // its Execution Mode and the policies (ADR 0134). A rename or a change of
    // priority is not that, and neither is a save that resubmits the same values:
    // a screen that posts its whole form would otherwise mint a Revision on every
    // click, and the Rule Runs would point at Revisions nothing distinguishes.
    const name = typeof input.name === 'string' ? input.name.trim() : undefined;
    const executionMode = input.executionMode as 'read_only' | 'approval' | 'unattended' | undefined;
    const selectionPolicy = input.selectionPolicy === undefined ? undefined : JSON.stringify(input.selectionPolicy);
    const priority = input.priority === undefined ? undefined : input.priority as number;
    const revises = (executionMode !== undefined && executionMode !== existing.executionMode)
      || (selectionPolicy !== undefined && selectionPolicy !== existing.selectionPolicy);
    const revision = revises ? existing.currentRevision + 1 : existing.currentRevision;
    if (input.state !== undefined || executionMode !== undefined || selectionPolicy !== undefined || name !== undefined || priority !== undefined) {
      const timestamp = now();
      await database.batch([
        database.update(accountRules)
          .set({
            ...(name === undefined ? {} : { name }),
            ...(input.state === undefined ? {} : { status: input.state as 'draft' | 'active' | 'suspended' | 'archived' }),
            ...(executionMode === undefined ? {} : { executionMode }),
            ...(selectionPolicy === undefined ? {} : { selectionPolicy }),
            ...(priority === undefined ? {} : { priority }),
            ...(revises ? { currentRevision: revision } : {}),
            updatedAt: timestamp,
          })
          .where(eq(accountRules.id, ruleId)),
        ...(revises ? [database.insert(ruleRevisions).values({
          id: crypto.randomUUID(),
          ruleId,
          revision,
          executionMode: executionMode ?? existing.executionMode,
          selectionPolicy: selectionPolicy ?? existing.selectionPolicy,
          routingPolicy: existing.routingPolicy,
          createdAt: timestamp,
        })] : []),
      ]);
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
    if (input.noticeContactListId !== undefined) {
      const noticeContactListId = (input.noticeContactListId as string | null) || null;
      if (noticeContactListId && !await database.select({ id: contactLists.id }).from(contactLists)
        .where(eq(contactLists.id, noticeContactListId)).get()) {
        return failure(context, 'The notice Contact List must belong to this Account.', 409);
      }
      await database.update(accountRules).set({ noticeContactListId, updatedAt: now() })
        .where(eq(accountRules.id, ruleId)).run();
    }
    return json(context, {
      id: ruleId,
      ...(input.noticeContactListId === undefined ? {} : { noticeContactListId: (input.noticeContactListId as string | null) || null }),
      ...(name === undefined ? {} : { name }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(selectionPolicy === undefined ? {} : { selectionPolicy: JSON.parse(selectionPolicy) as Record<string, unknown> }),
      ...(priority === undefined ? {} : { priority }),
      ...(revises ? { revision } : {}),
      ...(permittedRecipientListIds === undefined ? {} : { permittedRecipientListIds }),
      ...(permittedLineListIds === undefined ? {} : { permittedLineListIds }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:accountId/members', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      state: contacts.state,
      description: contacts.description,
      tags: contacts.tags,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      lineDestinationRowId: lineDestinations.id,
      lineDestinationId: lineDestinations.destinationId,
      lineDisplayName: lineDestinations.displayName,
      lineKind: lineDestinations.kind,
      lineStatus: lineDestinations.status,
      lineSource: lineDestinations.source,
    }).from(contacts)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.contactId, contacts.id))
      .leftJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
      .orderBy(asc(contacts.name)).all();
    const roster = new Map<string, {
      id: string;
      accountId: string;
      name: string;
      email: string;
      state: 'active' | 'inactive';
      description: string;
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
      const contact = roster.get(row.id) ?? {
        id: row.id,
        accountId: access.account.id,
        name: row.name,
        email: row.email,
        state: row.state,
        description: row.description,
        tags: JSON.parse(row.tags) as string[],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lineDestinations: [],
      };
      if (row.lineDestinationRowId && row.lineDestinationId && row.lineKind && row.lineStatus) {
        contact.lineDestinations.push({
          id: row.lineDestinationRowId,
          destinationId: displayLineDestinationId(row.lineDestinationId),
          displayName: row.lineDisplayName ?? '',
          kind: row.lineKind,
          status: row.lineStatus,
          source: row.lineSource ?? 'webhook',
        });
      }
      roster.set(row.id, contact);
    }
    return json(context, [...roster.values()]);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contacts could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/line-destinations', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select({
      id: lineDestinations.id,
      destinationId: lineDestinations.destinationId,
      displayName: lineDestinations.displayName,
      kind: lineDestinations.kind,
      status: lineDestinations.status,
      source: lineDestinations.source,
      discoveredAt: lineDestinations.discoveredAt,
      contactId: contactLineDestinations.contactId,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .orderBy(desc(lineDestinations.discoveredAt)).all();
    return json(context, rows.map((row) => ({
      ...row,
      destinationId: displayLineDestinationId(row.destinationId),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destinations could not be loaded.', 403);
  }
});

app.post('/api/organizations/:accountId/line-destinations', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ destinationId?: string; kind?: string; displayName?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) return failure(context, 'A valid LINE ID is required.');
    const kind: 'user' | 'group' | 'room' = input.kind === 'group' || input.kind === 'room' ? input.kind : 'user';
    const displayName = input.displayName?.trim() ?? '';
    const database = drizzleAccountDatabase(access.database);
    const connection = await database.select({ id: accountConnections.id }).from(accountConnections).where(and(
      eq(accountConnections.kind, 'line'),
      eq(accountConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'A LINE Connection must be configured before a LINE Destination can be entered manually.', 409);
    const existing = await database.select({
      id: lineDestinations.id,
      contactId: contactLineDestinations.contactId,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.contactId) return failure(context, 'This LINE ID is already linked to a member.', 409);
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
        contactId: null,
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
      contactId: null,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be registered.', 409);
  }
});

app.delete('/api/organizations/:accountId/line-destinations/:lineDestinationId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const lineDestinationId = context.req.param('lineDestinationId');
    const database = drizzleAccountDatabase(access.database);
    const existing = await database.select({
      id: lineDestinations.id,
      contactId: contactLineDestinations.contactId,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(eq(lineDestinations.id, lineDestinationId))
      .get();
    if (!existing) return failure(context, 'LINE Destination was not found.', 404);
    if (existing.contactId) return failure(context, 'Unlink this LINE Destination from its member before removing it.', 409);
    await database.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    return json(context, { id: lineDestinationId, removed: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be removed.', 409);
  }
});

app.get('/api/organizations/:accountId/members/export', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select({
      name: contacts.name,
      email: contacts.email,
    }).from(contacts).where(eq(contacts.state, 'active')).orderBy(asc(contacts.name)).all();
    return new Response(exportContactCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members.csv"' } });
  } catch (error) { return failure(context, error instanceof Error ? error.message : 'Contact export could not be created.', 403); }
});

app.post('/api/organizations/:accountId/members', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; description?: string; tags?: unknown; lineDestinationId?: string }>();
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase() ?? '';
    if (!name) return failure(context, 'Contact name is required.');
    if (email && !email.includes('@')) return failure(context, 'Contact email address must be valid when provided.');
    const tags = input.tags === undefined ? [] : input.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
      return failure(context, 'Contact tags must be non-empty strings.');
    }
    const normalizedTags = tags.map((tag) => String(tag).trim());
    const database = drizzleAccountDatabase(access.database);
    const requestedLineDestinationId = input.lineDestinationId?.trim();
    const lineDestination = requestedLineDestinationId
      ? await database.select({
        id: lineDestinations.id,
        destinationId: lineDestinations.destinationId,
        displayName: lineDestinations.displayName,
        kind: lineDestinations.kind,
        status: lineDestinations.status,
      }).from(lineDestinations)
        .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
        .where(and(
          eq(lineDestinations.id, requestedLineDestinationId),
          eq(lineDestinations.status, 'discovered'),
          isNull(contactLineDestinations.contactId),
        )).get()
      : null;
    if (requestedLineDestinationId && !lineDestination) {
      return failure(context, 'The LINE Destination is unavailable or already assigned.', 409);
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    const contactInsert = database.insert(contacts).values({
      id,
      accountId: access.account.id,
      name,
      email,
      state: 'active',
      description: input.description?.trim() ?? '',
      tags: JSON.stringify(normalizedTags),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (lineDestination) {
      await database.batch([
        contactInsert,
        database.insert(contactLineDestinations).values({
          contactId: id,
          lineDestinationId: lineDestination.id,
          createdAt: timestamp,
        }),
      ]);
    } else {
      await contactInsert.run();
    }
    return json(context, {
      id,
      accountId: access.account.id,
      name,
      email,
      state: 'active',
      description: input.description?.trim() ?? '',
      tags: normalizedTags,
      createdAt: timestamp,
      updatedAt: timestamp,
      lineDestinations: lineDestination ? [{
        ...lineDestination,
        destinationId: displayLineDestinationId(lineDestination.destinationId),
      }] : [],
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact could not be created.', 409);
  }
});

app.patch('/api/organizations/:accountId/members/:contactId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; description?: string; tags?: unknown; state?: string }>();
    const updates: Partial<typeof contacts.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return failure(context, 'Contact name cannot be empty.');
      updates.name = name;
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email && !email.includes('@')) return failure(context, 'Contact email address must be valid when provided.');
      updates.email = email;
    }
    if (input.description !== undefined) updates.description = input.description.trim();
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) return failure(context, 'Contact tags must be non-empty strings.');
      tags = input.tags.map((tag) => tag.trim());
      updates.tags = JSON.stringify(tags);
    }
    if (input.state !== undefined) {
      if (!['active', 'inactive'].includes(input.state)) return failure(context, 'Unsupported Contact state.');
      updates.state = input.state as 'active' | 'inactive';
    }
    if (Object.keys(updates).length === 0) return failure(context, 'At least one Contact field is required.');
    const updated = await drizzleAccountDatabase(access.database).update(contacts)
      .set({ ...updates, updatedAt: now() })
      .where(eq(contacts.id, context.req.param('contactId')))
      .returning({ id: contacts.id }).get();
    if (!updated) return failure(context, 'Contact was not found.', 404);
    return json(context, {
      id: context.req.param('contactId'),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(tags === undefined ? {} : { tags }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact could not be updated.', 409);
  }
});

app.post('/api/organizations/:accountId/members/:contactId/line-links', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    const database = drizzleAccountDatabase(access.database);
    await database.batch([
      database.update(contactLinkTokens).set({ usedAt: timestamp }).where(and(
        eq(contactLinkTokens.contactId, context.req.param('contactId')),
        isNull(contactLinkTokens.usedAt),
      )),
      database.insert(contactLinkTokens).values({
        token,
        contactId: context.req.param('contactId'),
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      }),
    ]);
    return json(context, {
      contactId: context.req.param('contactId'),
      token,
      expiresAt,
      linkUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.account.id)}/line-links/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact Link could not be issued.', 409);
  }
});

app.post('/api/organizations/:accountId/members/:contactId/portal-invitations', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const contactId = context.req.param('contactId');
    const database = drizzleAccountDatabase(access.database);
    // ADR 0119: the invitation is delivered to the Contact's LINE Destination,
    // and no alternative delivery is provided.
    const reachable = await database.select({ contactId: contactLineDestinations.contactId })
      .from(contactLineDestinations).where(eq(contactLineDestinations.contactId, contactId)).get();
    if (!reachable) return failure(context, 'LINE連携のないメンバーはContact Portalを利用できません。', 409);
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    await database.batch([
      database.update(portalInvitations).set({ usedAt: timestamp }).where(and(
        eq(portalInvitations.contactId, contactId),
        isNull(portalInvitations.usedAt),
      )),
      database.insert(portalInvitations).values({ token, contactId, expiresAt, usedAt: null, createdAt: timestamp }),
    ]);
    return json(context, {
      contactId,
      expiresAt,
      portalUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/portal/join/${encodeURIComponent(access.account.id)}/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Portal invitation could not be issued.', 409);
  }
});

app.put('/api/organizations/:accountId/members/:contactId/line-destination', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ destinationId?: string; kind?: string; displayName?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) return failure(context, 'A valid LINE ID is required.');
    const kind: 'user' | 'group' | 'room' = input.kind === 'group' || input.kind === 'room' ? input.kind : 'user';
    const displayName = input.displayName?.trim() ?? '';
    const contactId = context.req.param('contactId');
    const database = drizzleAccountDatabase(access.database);
    const contact = await database.select({ id: contacts.id })
      .from(contacts).where(eq(contacts.id, contactId)).get();
    if (!contact) return failure(context, 'Contact was not found.', 404);
    const connection = await database.select({ id: accountConnections.id }).from(accountConnections).where(and(
      eq(accountConnections.kind, 'line'),
      eq(accountConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'A LINE Connection must be configured before a LINE Destination can be entered manually.', 409);
    const existing = await database.select({
      id: lineDestinations.id,
      source: lineDestinations.source,
      contactId: contactLineDestinations.contactId,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.contactId && existing.contactId !== contactId) {
      return failure(context, 'This LINE ID is already linked to another member.', 409);
    }
    const previousManual = await database.select({ id: lineDestinations.id }).from(lineDestinations)
      .innerJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(
        eq(contactLineDestinations.contactId, contactId),
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
    if (!existing?.contactId) {
      await database.insert(contactLineDestinations).values({
        contactId,
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

app.delete('/api/organizations/:accountId/members/:contactId/line-destination/:lineDestinationId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const contactId = context.req.param('contactId');
    const lineDestinationId = context.req.param('lineDestinationId');
    const database = drizzleAccountDatabase(access.database);
    const link = await database.select({
      lineDestinationId: contactLineDestinations.lineDestinationId,
      source: lineDestinations.source,
    }).from(contactLineDestinations)
      .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
      .where(and(
        eq(contactLineDestinations.contactId, contactId),
        eq(contactLineDestinations.lineDestinationId, lineDestinationId),
      )).get();
    if (!link) return failure(context, 'LINE Destination link was not found.', 404);
    if (link.source === 'manual') {
      await database.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    } else {
      await database.delete(contactLineDestinations).where(and(
        eq(contactLineDestinations.contactId, contactId),
        eq(contactLineDestinations.lineDestinationId, lineDestinationId),
      )).run();
    }
    return json(context, { id: lineDestinationId, unlinked: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE Destination could not be unlinked.', 409);
  }
});

app.post('/api/organizations/:accountId/members/import/preview', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    return json(context, previewContactCsv(input.csv));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact import could not be previewed.', 409);
  }
});

app.post('/api/organizations/:accountId/members/import', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    const preview = previewContactCsv(input.csv);
    const timestamp = now();
    const database = drizzleAccountDatabase(access.database);
    const writes = await Promise.all(preview.accepted.map((contact) => database.insert(contacts).values({
      id: crypto.randomUUID(),
      accountId: access.account.id,
      name: contact.name,
      email: contact.email,
      state: 'active',
      tags: '[]',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning({ id: contacts.id }).get()));
    const imported = writes.filter(Boolean).length;
    return json(context, { imported, duplicates: preview.duplicates, invalid: preview.invalid }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact import could not be completed.', 409);
  }
});

app.get('/api/organizations/:accountId/dashboard', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const database = drizzleAccountDatabase(access.database);
    const [rules, activeAgentRules, events, jobs, exceptions, connection] = await Promise.all([
      database.select({ value: count() }).from(accountRules).where(eq(accountRules.status, 'active')).get(),
      database.select({ value: count() }).from(agentRules).where(eq(agentRules.status, 'active')).get(),
      database.select({ value: count() }).from(accountEvents).where(and(eq(accountEvents.status, 'scheduled'), gte(accountEvents.startsAt, now()))).get(),
      database.select({ value: count() }).from(accountJobs).where(inArray(accountJobs.state, ['pending', 'running'])).get(),
      database.select({ value: count() }).from(accountExceptions).where(eq(accountExceptions.state, 'open')).get(),
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

/**
 * The Guest Registrations on each Scheduled Event still ahead. This is the one
 * place the guests' names are shown: the Calendar description an invited Contact
 * reads carries the counts alone.
 */
app.get('/api/organizations/:accountId/guest-registrations', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const database = drizzleAccountDatabase(access.database);
    const rows = await database.select({
      eventId: accountEvents.id,
      title: accountEvents.title,
      startsAt: accountEvents.startsAt,
      name: guestRegistrations.name,
      affiliation: guestRegistrations.affiliation,
      attending: guestRegistrations.attending,
    }).from(guestRegistrations)
      .innerJoin(accountEvents, eq(accountEvents.id, guestRegistrations.eventId))
      .where(gte(accountEvents.endsAt, now()))
      .orderBy(asc(accountEvents.startsAt), asc(guestRegistrations.name)).all();
    const byEvent = new Map<string, {
      eventId: string;
      title: string;
      startsAt: string;
      guests: Array<{ name: string; affiliation: string; attending: boolean }>;
    }>();
    for (const row of rows) {
      const entry = byEvent.get(row.eventId)
        ?? { eventId: row.eventId, title: row.title, startsAt: row.startsAt, guests: [] };
      entry.guests.push({ name: row.name, affiliation: row.affiliation, attending: row.attending });
      byEvent.set(row.eventId, entry);
    }
    return json(context, [...byEvent.values()].map((entry) => ({
      ...entry,
      attendingCount: entry.guests.filter((guest) => guest.attending).length,
      affiliations: affiliationCounts(entry.guests),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Guest Registrations could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/tasks', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const assignee = context.req.query('assignee')?.trim();
    const event = context.req.query('event')?.trim();
    return json(context, await createTaskWorkflow(drizzleAccountDatabase(access.database)).list({
      ...(assignee === 'unassigned' ? { unassigned: true } : assignee ? { assigneeContactId: assignee } : {}),
      ...(event ? { event } : {}),
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Tasks could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/automation-warnings', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const rows = await drizzleAccountDatabase(access.database).select().from(automationWarnings)
      .orderBy(desc(automationWarnings.createdAt)).limit(100).all();
    return json(context, rows);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Warnings could not be loaded.', 403);
  }
});

/**
 * The Jobs that are not going to run themselves (ADR 0167).
 *
 * A Job left `running` was claimed by a pass that never finished it, and nothing
 * reclaims it: the sweep only takes `pending` rows. A `failed` one has spent its
 * retries. Both are invisible until somebody notices a reminder that never
 * arrived, so the operations screen states them.
 */
app.get('/api/organizations/:accountId/operations/jobs', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const rows = await drizzleAccountDatabase(access.database).select({
      id: accountJobs.id,
      kind: accountJobs.kind,
      state: accountJobs.state,
      attempts: accountJobs.attempts,
      availableAt: accountJobs.availableAt,
      lastError: accountJobs.lastError,
      updatedAt: accountJobs.updatedAt,
    }).from(accountJobs).where(inArray(accountJobs.state, ['running', 'failed']))
      .orderBy(desc(accountJobs.updatedAt)).limit(100).all();
    return json(context, rows);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Stuck Jobs could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:accountId/tasks/:taskId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ completed?: unknown; remarks?: unknown; assigneeContactId?: unknown }>();
    if (input.completed !== undefined && typeof input.completed !== 'boolean') return failure(context, 'Completed must be a boolean.');
    if (input.remarks !== undefined && (typeof input.remarks !== 'string' || input.remarks.length > 10_000)) return failure(context, 'Remarks must be at most 10,000 characters.');
    if (input.assigneeContactId !== undefined && input.assigneeContactId !== null && typeof input.assigneeContactId !== 'string') {
      return failure(context, 'The assignee must be a Contact identifier or null.');
    }
    const workflow = createTaskWorkflow(drizzleAccountDatabase(access.database));
    const taskId = context.req.param('taskId');
    // Naming the assignee is a separate write, so a Task may be handed on and
    // completed in one request without either half deciding the other's outcome.
    let assigned: Awaited<ReturnType<typeof workflow.assign>> = null;
    if (input.assigneeContactId !== undefined) {
      assigned = await workflow.assign(taskId, (input.assigneeContactId as string | null) || null);
      if (!assigned) return failure(context, 'Task or Contact was not found.', 404);
    }
    const changed = input.completed !== undefined || input.remarks !== undefined;
    const task = changed
      ? await workflow.update(taskId, {
        ...(typeof input.completed === 'boolean' ? { completed: input.completed } : {}),
        ...(typeof input.remarks === 'string' ? { remarks: input.remarks } : {}),
      })
      : assigned;
    if (!task) return failure(context, 'Task was not found or no change was supplied.', 404);
    return json(context, task);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Task could not be updated.', 409);
  }
});

app.post('/api/organizations/:accountId/recovery-requests', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    const input = await context.req.json<{ idempotencyKey?: string }>();
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) return failure(context, 'A recovery receipt idempotency key is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    await drizzleControlDatabase(context.env.CONTROL_DB).insert(recoveryRequests).values({
      id,
      accountId: access.account.id,
      idempotencyKey,
      state: 'requested',
      requestedByIdentityId: access.session.identity_id,
      createdAt: timestamp,
    }).run();
    return json(context, { id, accountId: access.account.id, idempotencyKey, state: 'requested', createdAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery request could not be created.', 409);
  }
});

app.patch('/api/organizations/:accountId/events/:eventId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
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
    const updates: Partial<typeof accountEvents.$inferInsert> = {};
    if (changeSet.title !== undefined) updates.title = changeSet.title;
    if (changeSet.startsAt !== undefined) updates.startsAt = changeSet.startsAt;
    if (changeSet.endsAt !== undefined) updates.endsAt = changeSet.endsAt;
    if (changeSet.location !== undefined) updates.location = changeSet.location;
    if (changeSet.description !== undefined) updates.description = changeSet.description;
    if (status !== undefined) updates.status = status as 'draft' | 'scheduled' | 'cancelled' | 'exception';
    const timestamp = now();
    const database = drizzleAccountDatabase(access.database);
    const updated = await database.update(accountEvents).set({ ...updates, updatedAt: timestamp })
      .where(eq(accountEvents.id, context.req.param('eventId')))
      .returning({ id: accountEvents.id }).get();
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

app.post('/api/organizations/:accountId/events/:eventId/recipient-snapshots', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ contactIds?: unknown }>();
    if (!Array.isArray(input.contactIds) || !input.contactIds.length || input.contactIds.some((id) => typeof id !== 'string' || !id.trim())) return failure(context, 'At least one Contact is required.');
    const contactIds = [...new Set(input.contactIds.map((id) => id.trim()))];
    const database = drizzleAccountDatabase(access.database);
    const recipients = await database.select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
    }).from(contacts).where(and(
      inArray(contacts.id, contactIds),
      eq(contacts.state, 'active'),
    )).all();
    if (recipients.length !== contactIds.length) return failure(context, 'One or more active Contacts were not found.', 404);
    const timestamp = now();
    await Promise.all(recipients.map((recipient) => database.insert(attendance).values({
      eventId: context.req.param('eventId'),
      contactId: recipient.id,
      status: 'unanswered',
      comment: '',
      updatedAt: now(),
    }).onConflictDoNothing().run()));
    await Promise.all(recipients.map((recipient) => database.insert(eventRecipients).values({
      eventId: context.req.param('eventId'),
      contactId: recipient.id,
      nameSnapshot: recipient.name,
      emailSnapshot: recipient.email,
      createdAt: timestamp,
    }).onConflictDoNothing().run()));
    return json(context, { eventId: context.req.param('eventId'), snapshotted: recipients.length }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient snapshots could not be created.', 409);
  }
});

app.get('/api/organizations/:accountId/audit/deliveries', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(accountDeliveries)
      .orderBy(desc(accountDeliveries.createdAt)).limit(100).all();
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

app.get('/api/organizations/:accountId/operations/exceptions', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(accountExceptions)
      .orderBy(desc(accountExceptions.createdAt)).limit(100).all();
    return json(context, rows.map((row) => ({
      id: row.id, sourceMessageId: row.sourceMessageId, code: row.code, message: row.message, state: row.state, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exceptions could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:accountId/operations/exceptions/:exceptionId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ action?: string }>();
    const database = drizzleAccountDatabase(access.database);
    if (input.action === 'resolve') {
      const updated = await database.update(accountExceptions).set({ state: 'resolved', resolvedAt: now() }).where(and(
        eq(accountExceptions.id, context.req.param('exceptionId')),
        ne(accountExceptions.state, 'resolved'),
      )).returning({ id: accountExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found or already resolved.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'resolved' });
    }
    if (input.action === 'retry') {
      const updated = await database.update(accountExceptions).set({ state: 'retry_requested', resolvedAt: null })
        .where(eq(accountExceptions.id, context.req.param('exceptionId')))
        .returning({ id: accountExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'retry_requested' });
    }
    return failure(context, 'Unsupported Exception action.');
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exception could not be updated.', 409);
  }
});

app.post('/api/public/organizations/:accountId/line/webhook', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const database = await activeAccountDatabase(context.env, accountId);
    if (!database) return failure(context, 'LINE webhook was not found.', 404);
    const accountDb = drizzleAccountDatabase(database);
    const connection = await accountDb.select().from(accountConnections).where(and(
      eq(accountConnections.kind, 'line'),
      eq(accountConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'LINE webhook was not found.', 404);
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const credential = await connectionCredential(connection, accountKey, accountId, 'line');
    const rawBody = await context.req.text();
    const signature = context.req.header('x-line-signature') ?? '';
    if (!credential.channelSecret || !await verifyLineWebhookSignature(credential.channelSecret, rawBody, signature)) return failure(context, 'Invalid LINE webhook signature.', 401);
    const payload = JSON.parse(rawBody) as LineWebhookPayload;
    const destinations = discoveredLineDestinations(payload);
    const timestamp = now();
    const persistence = Promise.all(destinations.map(async (destination) => {
      const displayName = await lineDestinationDisplayName(credential, destination, payload);
      await accountDb.insert(lineDestinations).values({
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

app.post('/api/public/organizations/:accountId/line-links/:token', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const database = await activeAccountDatabase(context.env, accountId);
    if (!database) return failure(context, 'Contact Link was not found.', 404);
    const accountDb = drizzleAccountDatabase(database);
    const input = await context.req.json<{ destinationId?: string }>();
    if (!input.destinationId?.trim()) return failure(context, 'A discovered LINE Destination is required.');
    const link = await accountDb.select({
      contactId: contactLinkTokens.contactId,
    }).from(contactLinkTokens).where(and(
      eq(contactLinkTokens.token, context.req.param('token')),
      isNull(contactLinkTokens.usedAt),
      gt(contactLinkTokens.expiresAt, now()),
    )).get();
    if (!link) return failure(context, 'Contact Link has expired or was already used.', 410);
    const destination = await accountDb.select({ id: lineDestinations.id }).from(lineDestinations).where(and(
      eq(lineDestinations.destinationId, input.destinationId.trim()),
      eq(lineDestinations.status, 'discovered'),
    )).limit(1).get();
    if (!destination) return failure(context, 'LINE Destination was not found.', 404);
    const timestamp = now();
    await accountDb.insert(contactLineDestinations).values({
      contactId: link.contactId,
      lineDestinationId: destination.id,
      createdAt: timestamp,
    }).onConflictDoNothing().run();
    const consumed = await accountDb.update(contactLinkTokens).set({ usedAt: timestamp }).where(and(
      eq(contactLinkTokens.token, context.req.param('token')),
      isNull(contactLinkTokens.usedAt),
    )).returning({ token: contactLinkTokens.token }).get();
    if (!consumed) return failure(context, 'Contact Link was already used.', 410);
    return json(context, {
      contactId: link.contactId,
      destinationId: displayLineDestinationId(input.destinationId.trim()),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact Link could not be consumed.', 409);
  }
});

app.patch('/api/organizations/:accountId/suspension', async (context) => {
  try {
    const session = await sessionFromRequest(context.req.raw, context.env);
    if (!session) return failure(context, 'Authentication is required.', 401);
    const accountId = context.req.param('accountId');
    const control = drizzleControlDatabase(context.env.CONTROL_DB);
    const membership = await control.select({
      id: accounts.id,
      status: accounts.status,
    }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId)).where(and(
      eq(accountIdentities.identityId, session.identity_id),
      eq(accountIdentities.accountId, accountId),
      eq(accountIdentities.state, 'active'),
    )).get();
    if (!membership) return failure(context, 'この組織へのアクセス権がありません。', 403);
    const input = await context.req.json<{ suspended?: boolean }>();
    if (typeof input.suspended !== 'boolean') return failure(context, 'A suspension state is required.');
    const status = input.suspended ? 'suspended' : 'active';
    await control.update(accounts).set({ status, updatedAt: now() })
      .where(eq(accounts.id, accountId)).run();
    return json(context, { accountId, status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Account suspension could not be changed.', 409);
  }
});


const MCP_REVISIONS = ['2026-07-28', '2025-06-18'] as const;

const chatAiConnection = async (input: { database: D1Database; accountKey: CryptoKey; accountId: string }) => {
  const existing = await drizzleAccountDatabase(input.database).select().from(accountConnections)
    .where(and(eq(accountConnections.kind, 'ai'), eq(accountConnections.status, 'active'))).limit(1).get();
  if (!existing) throw new Error('OpenAI 互換 API を設定してください。');
  const credential = await connectionCredential(existing, input.accountKey, input.accountId, 'ai');
  const model = credential.model?.trim();
  const baseUrl = normalizedAiBaseUrl(credential.baseUrl || LEGACY_AI_BASE_URL);
  if (!credential.apiKey || !model || !baseUrl) throw new Error('OpenAI 互換 API を設定してください。');
  return { apiKey: credential.apiKey, baseUrl, model };
};

app.get('/api/organizations/:accountId/mcp-servers', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      revision: row.revision,
      authenticated: Boolean(row.tokenEnvelope),
      updatedAt: row.updatedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'MCP Servers could not be loaded.', 403);
  }
});

app.put('/api/organizations/:accountId/mcp-servers/:serverId', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; url?: string; token?: string | null; revision?: string | null }>();
    const name = input.name?.trim() ?? '';
    const url = input.url?.trim() ?? '';
    if (!name || name.length > 40 || !/^[a-z0-9_-]+$/u.test(name)) {
      return failure(context, 'MCP Server 名は英小文字・数字・ハイフン・アンダースコアで 1〜40 文字にしてください。');
    }
    if (!/^https:\/\//u.test(url)) return failure(context, 'MCP Server の URL は https で始まる必要があります。');
    const revision = input.revision ?? null;
    if (revision !== null && !MCP_REVISIONS.includes(revision as (typeof MCP_REVISIONS)[number])) {
      return failure(context, 'MCP のリビジョン指定が不正です。');
    }
    await saveChatServer({
      database: access.database,
      accountKey: await accountKeyForRequest(context.env, accountId),
      accountId,
      id: context.req.param('serverId'),
      name,
      url,
      token: input.token?.trim() || null,
      revision: revision as '2026-07-28' | '2025-06-18' | null,
      timestamp: now(),
    });
    return json(context, { id: context.req.param('serverId'), name, url });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'MCP Server could not be saved.', 409);
  }
});

app.delete('/api/organizations/:accountId/mcp-servers/:serverId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    await deleteChatServer({ database: access.database, id: context.req.param('serverId') });
    return json(context, { id: context.req.param('serverId'), deleted: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'MCP Server could not be removed.', 409);
  }
});

/**
 * Sending one arbitrary message as a test (ADR 0158).
 *
 * An operator states a Contact, a Channel and a text, and the message travels the
 * same seam an Automation and the MCP Server send through, so a test that
 * arrives proves the production path and not a second one written for testing.
 * Repeat suppression is not consulted, because a test whose second run silently
 * sends nothing would report the Channel as working when it never spoke. Several
 * messages may be stated, so an operator can watch LINE's five-per-request batch
 * happen instead of taking it on trust.
 */
app.get('/api/organizations/:accountId/channel-tests/targets', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) return failure(context, 'Account データベースに接続できません。', 503);
    const reachable = await reachableContacts({ database: access.database });
    return json(context, reachable.filter((contact) => contact.channels.length > 0));
  } catch (error) {
    const message = error instanceof Error ? error.message : '送信先を取得できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.post('/api/organizations/:accountId/channel-tests', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, 'Account データベースに接続できません。', 503);
    const input = await context.req.json<{ contactId?: string; channel?: string; texts?: unknown }>();
    const contactId = input.contactId?.trim() ?? '';
    const channel = input.channel?.trim() ?? '';
    const texts = Array.isArray(input.texts) ? input.texts.filter((text): text is string => typeof text === 'string') : [];
    const said = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (!contactId) return failure(context, '送信先の Contact を選んでください。');
    if (!said.length || said.length > LINE_BATCH_LIMIT) {
      return failure(context, `テストは 1 回に 1〜${LINE_BATCH_LIMIT} 通まで送れます。`);
    }
    if (said.some((text) => text.length > 1_000)) return failure(context, 'テストメッセージは 1 通 1,000 文字以内で入力してください。');
    const delivery = await sendOnChannel({
      database: access.database,
      credentials: await channelCredentials({
        database: access.database,
        accountKey: await accountKeyForRequest(context.env, accountId),
        accountId,
      }),
      contactId,
      channel,
      texts: said,
    });
    return json(context, { ...delivery, sentAt: now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'テスト送信に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 409);
  }
});

/**
 * Calling one registered MCP Server for real (ADR 0142, ADR 0158).
 *
 * Without a tool name this lists what the server offers, which is the cheapest
 * proof that the URL, the token and the revision are right. With one it calls
 * that tool with the arguments given and returns the server's own answer,
 * failures included, so a LINE MCP Server can be made to send a real message.
 */
app.post('/api/organizations/:accountId/mcp-servers/:serverId/tests', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const serverId = context.req.param('serverId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, 'Account データベースに接続できません。', 503);
    const input = await context.req.json<{ tool?: string; arguments?: unknown }>();
    const servers = await listChatServers({
      database: access.database,
      accountKey: await accountKeyForRequest(context.env, accountId),
      accountId,
    });
    const server = servers.find(({ id }) => id === serverId);
    if (!server) return failure(context, 'その MCP Server は登録されていません。', 404);
    const request = (url: string, init: RequestInit) => fetch(url, init);
    const tool = input.tool?.trim() ?? '';
    if (!tool) {
      const tools = await listMcpTools({ connection: server.connection, fetch: request });
      return json(context, { server: server.name, tools });
    }
    const argument = input.arguments;
    if (argument !== undefined && (typeof argument !== 'object' || argument === null || Array.isArray(argument))) {
      return failure(context, 'ツールの引数は JSON オブジェクトで指定してください。');
    }
    const result = await callMcpTool({
      connection: server.connection,
      fetch: request,
      name: tool,
      arguments: (argument ?? {}) as Record<string, unknown>,
    });
    return json(context, { server: server.name, tool, isError: result.isError, text: result.text });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP Server を呼び出せませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 503);
  }
});

app.get('/api/organizations/:accountId/chat', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await listChatConversations(access.database));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operator Chat could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/chat/:conversationId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await readChatTurns({ database: access.database, conversationId: context.req.param('conversationId') }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Operator Chat could not be loaded.', 403);
  }
});

/** One exchange of Operator Chat, recorded as one Rule Run (ADR 0146). */
app.post('/api/organizations/:accountId/chat', async (context) => {
  const model: ChatModelPort = { complete: completeChatTurn };
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ conversationId?: string | null; message?: string }>();
    const message = input.message?.trim() ?? '';
    if (!message || message.length > 10_000) return failure(context, 'メッセージは 1〜10,000 文字で入力してください。');

    const accountKey = await accountKeyForRequest(context.env, accountId);
    const connection = await chatAiConnection({ database: access.database, accountKey, accountId });
    const servers = await listChatServers({ database: access.database, accountKey, accountId });
    const resolved = await resolveChatTools({ servers, fetch: (url, init) => fetch(url, init), executionMode: 'unattended' });

    const conversationId = await ensureChatConversation({
      database: access.database,
      accountId,
      conversationId: input.conversationId ?? null,
      title: message,
      timestamp: now(),
    });
    const history = await chatHistory({ database: access.database, conversationId });
    const execution = ruleExecutionForRequest({ env: context.env, database: access.database, accountId });
    const run = await execution.open({ intent: { kind: 'chat' } });
    const turn = await openChatTurn({ database: access.database, conversationId, ruleRunId: run.id, request: message, timestamp: now() });

    try {
      const result = await runChatTurn({
        model,
        connection,
        request: message,
        history,
        tools: resolved.tools,
        fetch: (url, init) => fetch(url, init),
        internal: chatInternalHandlers(access.database),
      });
      await closeChatTurn({
        database: access.database,
        turnId: turn.turnId,
        outcome: { status: 'completed', response: result.output },
        timestamp: now(),
      });
      await execution.close({ runId: run.id, outcome: 'completed' });
      return json(context, {
        conversationId,
        turnId: turn.turnId,
        ruleRunId: turn.ruleRunId,
        response: result.output,
        toolCallCount: result.toolCallCount,
        unreachableServers: resolved.failures,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Operator Chat turn failed.';
      await closeChatTurn({
        database: access.database,
        turnId: turn.turnId,
        outcome: { status: 'failed', error: detail },
        timestamp: now(),
      });
      await execution.close({ runId: run.id, outcome: 'failed' });
      return failure(context, detail, 503);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Operator Chat turn failed.';
    return failure(context, detail, detail === 'Authentication is required.' ? 401 : 409);
  }
});


interface DiscordCredential {
  botToken?: string;
  applicationPublicKey?: string;
}

const discordCredentialFor = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
}): Promise<DiscordCredential | null> => {
  const existing = await drizzleAccountDatabase(input.database).select().from(accountConnections)
    .where(and(eq(accountConnections.kind, 'discord'), eq(accountConnections.status, 'active'))).limit(1).get();
  if (!existing) return null;
  return JSON.parse(
    await decrypt(JSON.parse(existing.credential), input.accountKey, `organization-connection:${input.accountId}:discord`),
  ) as DiscordCredential;
};

app.put('/api/organizations/:accountId/connections/discord', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) return failure(context, 'Account データベースに接続できません。', 503);
    const input = await context.req.json<{ botToken?: string; applicationPublicKey?: string }>();
    const botToken = input.botToken?.trim() ?? '';
    const applicationPublicKey = input.applicationPublicKey?.trim().toLowerCase() ?? '';
    if (!botToken) return failure(context, 'Discord の Bot トークンを入力してください。');
    if (!/^[0-9a-f]{64}$/u.test(applicationPublicKey)) {
      return failure(context, 'Discord のアプリケーション公開鍵は 64 文字の16進数です。');
    }
    const db = drizzleAccountDatabase(access.database);
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const existing = await db.select().from(accountConnections)
      .where(and(eq(accountConnections.kind, 'discord'), eq(accountConnections.status, 'active'))).limit(1).get();
    const envelope = await encrypt(
      JSON.stringify({ botToken, applicationPublicKey }),
      accountKey,
      `organization-connection:${accountId}:discord`,
    );
    const timestamp = now();
    if (existing) {
      await db.update(accountConnections).set({ credential: JSON.stringify(envelope), updatedAt: timestamp })
        .where(eq(accountConnections.id, existing.id)).run();
    } else {
      await db.insert(accountConnections).values({
        id: crypto.randomUUID(),
        kind: 'discord',
        label: 'Discord',
        credential: JSON.stringify(envelope),
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
    }
    return json(context, {
      configured: true,
      interactionsUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/discord/interactions`,
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Discord 接続を保存できませんでした。', 403);
  }
});

/**
 * Discord's Interactions endpoint. Workers cannot hold the Gateway connection a
 * bot normally reads messages on, so this is where an Account's people reach it,
 * and a Channel Handle is discovered from the interaction that arrives.
 */
app.post('/api/public/organizations/:accountId/discord/interactions', async (context) => {
  const accountId = context.req.param('accountId');
  const body = await context.req.text();
  const signature = context.req.header('X-Signature-Ed25519') ?? '';
  const timestamp = context.req.header('X-Signature-Timestamp') ?? '';
  try {
    const database = await activeAccountDatabase(context.env, accountId);
    if (!database) return context.text('unavailable', 503);
    const accountKey = await accountKeyForRequest(context.env, accountId);
    const credential = await discordCredentialFor({ database, accountKey, accountId });
    if (!credential?.applicationPublicKey) return context.text('not configured', 503);
    const verified = await verifyDiscordSignature({
      publicKey: credential.applicationPublicKey,
      signature,
      timestamp,
      body,
    });
    if (!verified) return context.text('invalid request signature', 401);

    const interaction = JSON.parse(body || '{}') as DiscordInteraction;
    const handle = discordHandleFromInteraction(interaction);
    if (handle) {
      const connection = await drizzleAccountDatabase(database).select().from(accountConnections)
        .where(and(eq(accountConnections.kind, 'discord'), eq(accountConnections.status, 'active'))).limit(1).get();
      if (connection) {
        const stamp = now();
        await drizzleAccountDatabase(database).insert(channelHandles).values({
          id: crypto.randomUUID(),
          contactId: null,
          channel: 'discord',
          connectionId: connection.id,
          externalId: handle.externalId,
          replyTarget: handle.channelId,
          kind: handle.kind,
          displayName: handle.displayName,
          source: 'inbound',
          isPrimary: true,
          createdAt: stamp,
          updatedAt: stamp,
        }).onConflictDoUpdate({
          target: [channelHandles.channel, channelHandles.connectionId, channelHandles.externalId],
          set: { replyTarget: handle.channelId, displayName: handle.displayName, updatedAt: stamp },
        }).run();
      }
    }
    return context.json(discordReply(interaction));
  } catch (error) {
    return context.text(error instanceof Error ? error.message : 'discord interaction failed', 503);
  }
});

app.get('/api/organizations/:accountId/contact-lists', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const db = drizzleAccountDatabase(access.database);
    const rows = await db.select().from(contactLists).orderBy(asc(contactLists.name)).all();
    const memberships = rows.length
      ? await db.select().from(contactListMembers).where(inArray(contactListMembers.listId, rows.map(({ id }) => id))).all()
      : [];
    return json(context, rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      contactIds: memberships.flatMap((entry) => entry.listId === row.id ? [entry.contactId] : []),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact Lists could not be loaded.', 403);
  }
});

app.put('/api/organizations/:accountId/contact-lists/:listId', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const listId = context.req.param('listId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; description?: string; contactIds?: unknown }>();
    const name = input.name?.trim() ?? '';
    if (!name || name.length > 60) return failure(context, 'Contact List 名は 1〜60 文字で入力してください。');
    const contactIds = Array.isArray(input.contactIds) ? input.contactIds.filter((id): id is string => typeof id === 'string') : [];
    const db = drizzleAccountDatabase(access.database);
    const timestamp = now();
    await db.insert(contactLists).values({
      id: listId, accountId, name, description: input.description?.trim() ?? '', createdAt: timestamp, updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: contactLists.id,
      set: { name, description: input.description?.trim() ?? '', updatedAt: timestamp },
    }).run();
    await db.delete(contactListMembers).where(eq(contactListMembers.listId, listId)).run();
    for (const contactId of contactIds) {
      await db.insert(contactListMembers).values({ listId, contactId }).onConflictDoNothing().run();
    }
    return json(context, { id: listId, name, contactIds });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Contact List could not be saved.', 409);
  }
});

app.get('/api/organizations/:accountId/access-tokens', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const db = drizzleAccountDatabase(access.database);
    const rows = await db.select().from(accessTokens).orderBy(asc(accessTokens.name)).all();
    const grants = rows.length
      ? await db.select().from(accessTokenTools).where(inArray(accessTokenTools.tokenId, rows.map(({ id }) => id))).all()
      : [];
    return json(context, rows.map((row) => ({
      id: row.id,
      name: row.name,
      contactListId: row.contactListId,
      suppressionWindow: row.suppressionWindow,
      callsPerHour: row.callsPerHour,
      writesPerDay: row.writesPerDay,
      lastUsedAt: row.lastUsedAt,
      tools: grants.flatMap((grant) => grant.tokenId === row.id ? [grant.tool] : []),
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Access Tokens could not be loaded.', 403);
  }
});

/** Issues a Token once; the credential is shown here and never again, because only its hash is stored. */
app.post('/api/organizations/:accountId/access-tokens', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ name?: string; contactListId?: string; tools?: unknown; suppressionWindow?: string; callsPerHour?: number; writesPerDay?: number }>();
    const name = input.name?.trim() ?? '';
    const contactListId = input.contactListId?.trim() ?? '';
    if (!name || name.length > 60) return failure(context, 'Access Token 名は 1〜60 文字で入力してください。');
    if (!contactListId) return failure(context, '到達できる Contact List を選んでください。');
    const requested = Array.isArray(input.tools) ? input.tools.filter((tool): tool is string => typeof tool === 'string') : [];
    const tools = grantedServerTools(requested).map((tool) => tool.name);
    if (!tools.length) return failure(context, '許可するツールを1つ以上選んでください。');
    const window = input.suppressionWindow ?? 'day';
    if (!SUPPRESSION_WINDOWS.includes(window as SuppressionWindow)) return failure(context, '重複抑止の窓の指定が不正です。');
    const db = drizzleAccountDatabase(access.database);
    const list = await db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, contactListId)).get();
    if (!list) return failure(context, '指定された Contact List が見つかりません。', 404);
    const token = generateAccessToken();
    const id = crypto.randomUUID();
    const timestamp = now();
    await db.insert(accessTokens).values({
      id,
      accountId,
      name,
      tokenHash: await accessTokenHash(token),
      contactListId,
      suppressionWindow: window as SuppressionWindow,
      callsPerHour: Math.max(1, Math.min(input.callsPerHour ?? 60, 1_000)),
      writesPerDay: Math.max(1, Math.min(input.writesPerDay ?? 100, 10_000)),
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    for (const tool of tools) await db.insert(accessTokenTools).values({ tokenId: id, tool }).run();
    return json(context, {
      id,
      name,
      tools,
      token,
      url: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/mcp`,
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Access Token could not be issued.', 409);
  }
});

app.delete('/api/organizations/:accountId/access-tokens/:tokenId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    await drizzleAccountDatabase(access.database).delete(accessTokens)
      .where(eq(accessTokens.id, context.req.param('tokenId'))).run();
    return json(context, { id: context.req.param('tokenId'), revoked: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Access Token could not be revoked.', 409);
  }
});

/** The MCP Server an outside agent reaches (ADR 0152). Authenticated by Access Token alone. */
app.post('/api/public/organizations/:accountId/mcp', async (context) => {
  const rpcError = (code: number, message: string, status: 200 | 401 | 429 | 503) =>
    context.json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);
  try {
    const accountId = context.req.param('accountId');
    const presented = presentedToken(context.req.raw);
    if (!presented) return rpcError(-32001, 'An Access Token must be presented in the Authorization header.', 401);
    const database = await activeAccountDatabase(context.env, accountId);
    if (!database) return rpcError(-32003, 'This Account is not available.', 503);
    const token = await authenticateAccessToken({ database, presented });
    if (!token) return rpcError(-32001, 'This Access Token is not recognised.', 401);

    const request = await context.req.json<JsonRpcRequest>();
    const at = new Date();
    const calledTool = request.method === 'tools/call' && typeof request.params?.name === 'string' ? request.params.name : null;
    const isWrite = MCP_SERVER_TOOLS.some((tool) => tool.name === calledTool && tool.isWrite);
    const admitted = await admitAccessTokenCall({ database, token, tool: calledTool ?? request.method, isWrite, at });
    if (!admitted.admitted) return rpcError(-32002, admitted.reason ?? 'This Access Token has spent its limit.', 429);

    const accountKey = await accountKeyForRequest(context.env, accountId);
    const response = await handleMcpServerRequest({
      request,
      grant: token.grant,
      contactIds: token.contactIds,
      prompts: await publishedPrompts(database),
      ports: mcpServerPorts({
        database,
        credentials: await channelCredentials({ database, accountKey, accountId }),
      }),
      suppression: suppressionPort({ database, scope: token.id, window: token.suppressionWindow, at }),
      scope: token.id,
      window: token.suppressionWindow,
      at,
    });
    return context.json(response);
  } catch (error) {
    return rpcError(-32603, error instanceof Error ? error.message : 'The MCP Server failed.', 503);
  }
});


const AUTOMATION_STATES = ['draft', 'active', 'suspended', 'archived'] as const;
const INTERNAL_TOOL_NAMES = [...CHAT_INTERNAL_TOOLS, ...INTERNAL_WRITE_TOOLS].map((tool) => tool.name);

const automationView = (row: typeof accountAutomations.$inferSelect, tools: string[]) => ({
  id: row.id,
  name: row.name,
  promptId: row.promptId,
  contactListId: row.contactListId,
  schedule: row.schedule,
  offsetMinutes: row.offsetMinutes,
  executionMode: row.executionMode,
  suppressionWindow: row.suppressionWindow,
  state: row.state,
  nextRunAt: row.nextRunAt,
  lastRunAt: row.lastRunAt,
  lastError: row.lastError,
  tools,
});

app.get('/api/organizations/:accountId/automations', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const db = drizzleAccountDatabase(access.database);
    const rows = await db.select().from(accountAutomations).orderBy(asc(accountAutomations.name)).all();
    const grants = rows.length
      ? await db.select().from(automationTools).where(inArray(automationTools.automationId, rows.map(({ id }) => id))).all()
      : [];
    return json(context, rows.map((row) => automationView(
      row,
      grants.flatMap((grant) => grant.automationId === row.id ? [grant.tool] : []),
    )));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automations could not be loaded.', 403);
  }
});

app.get('/api/organizations/:accountId/automations/:automationId/runs', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await drizzleAccountDatabase(access.database).select().from(automationRuns)
      .where(eq(automationRuns.automationId, context.req.param('automationId')))
      .orderBy(desc(automationRuns.startedAt)).limit(20).all();
    return json(context, rows);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation runs could not be loaded.', 403);
  }
});

app.put('/api/organizations/:accountId/automations/:automationId', async (context) => {
  try {
    const accountId = context.req.param('accountId');
    const automationId = context.req.param('automationId');
    const access = await accountForRequest(context.req.raw, context.env, accountId);
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{
      name?: string; promptId?: string; contactListId?: string | null; schedule?: string;
      offsetMinutes?: number; executionMode?: string; suppressionWindow?: string; state?: string; tools?: unknown;
    }>();
    const name = input.name?.trim() ?? '';
    const promptId = input.promptId?.trim() ?? '';
    const schedule = input.schedule?.trim() ?? '';
    if (!name || name.length > 60) return failure(context, 'Automation 名は 1〜60 文字で入力してください。');
    if (!promptId) return failure(context, 'Prompt を選んでください。');
    if (!parseSchedule(schedule)) {
      return failure(context, 'スケジュールは daily HH:MM / weekly mon HH:MM / hourly :MM の形式で入力してください。');
    }
    const offsetMinutes = Math.trunc(input.offsetMinutes ?? 0);
    if (offsetMinutes < -840 || offsetMinutes > 840) return failure(context, 'タイムゾーンのオフセットが範囲外です。');
    const executionMode = input.executionMode ?? 'unattended';
    if (!['read_only', 'approval', 'unattended'].includes(executionMode)) return failure(context, '実行モードの指定が不正です。');
    const suppressionWindow = input.suppressionWindow ?? 'day';
    if (!SUPPRESSION_WINDOWS.includes(suppressionWindow as SuppressionWindow)) return failure(context, '重複抑止の窓の指定が不正です。');
    const state = input.state ?? 'draft';
    if (!AUTOMATION_STATES.includes(state as (typeof AUTOMATION_STATES)[number])) return failure(context, '状態の指定が不正です。');
    const requested = Array.isArray(input.tools) ? input.tools.filter((tool): tool is string => typeof tool === 'string') : [];
    const contactListId = input.contactListId?.trim() || null;
    const writesGranted = requested.some((tool) => INTERNAL_WRITE_TOOLS.some((write) => write.name === tool));
    if (writesGranted && !contactListId) {
      return failure(context, '送信を許可する Automation には、届けてよい Contact List が必要です。');
    }

    const db = drizzleAccountDatabase(access.database);
    const timestamp = now();
    const nextRunAt = state === 'active'
      ? nextScheduledRun({ schedule, offsetMinutes, after: new Date(timestamp) })
      : null;
    await db.insert(accountAutomations).values({
      id: automationId,
      accountId,
      name,
      promptId,
      contactListId,
      schedule,
      offsetMinutes,
      executionMode: executionMode as 'read_only' | 'approval' | 'unattended',
      suppressionWindow: suppressionWindow as SuppressionWindow,
      state: state as (typeof AUTOMATION_STATES)[number],
      nextRunAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: accountAutomations.id,
      set: {
        name, promptId, contactListId, schedule, offsetMinutes,
        executionMode: executionMode as 'read_only' | 'approval' | 'unattended',
        suppressionWindow: suppressionWindow as SuppressionWindow,
        state: state as (typeof AUTOMATION_STATES)[number],
        nextRunAt, updatedAt: timestamp,
      },
    }).run();
    await db.delete(automationTools).where(eq(automationTools.automationId, automationId)).run();
    for (const tool of requested) {
      await db.insert(automationTools).values({ automationId, tool }).onConflictDoNothing().run();
    }
    return json(context, { id: automationId, name, schedule, state, nextRunAt, tools: requested, availableInternalTools: INTERNAL_TOOL_NAMES });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation could not be saved.', 409);
  }
});

app.delete('/api/organizations/:accountId/automations/:automationId', async (context) => {
  try {
    const access = await accountForRequest(context.req.raw, context.env, context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    await drizzleAccountDatabase(access.database).delete(accountAutomations)
      .where(eq(accountAutomations.id, context.req.param('automationId'))).run();
    return json(context, { id: context.req.param('automationId'), deleted: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation could not be removed.', 409);
  }
});

app.all('/api/*', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  return failure(context, 'The previous shared-ORG_DB management API has been retired. Account-scoped operations are introduced in the next implementation unit.', 410);
});

const sessionFromRequest = async (request: Request, env: Bindings): Promise<SessionRow | null> => {
  return createRequestContext(request, env).session();
};

export { app };
