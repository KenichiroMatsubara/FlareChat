import { LEGACY_AI_BASE_URL } from '../ai';
import { readConnection, saveConnection, type ConnectionCredential } from '../connections';
import { normalizedAiBaseUrl, openAiChatCompletionsUrl } from '../event-details';
import type { Providers } from '../providers';
import { conflict, invalid, upstream } from '../refusal';
import { resource } from '../response';
import { accountRoute } from './account';

interface OpenAiCompatibleResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export const generatedText = (response: OpenAiCompatibleResponse): string =>
  response.choices?.[0]?.message?.content?.trim() ?? '';

export const lineWebhookUrl = (appUrl: string, accountId: string): string =>
  `${appUrl.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/line/webhook`;

const lineView = (line: ConnectionCredential) => ({
  channelAccessTokenConfigured: Boolean(line.channelAccessToken),
  channelSecretConfigured: Boolean(line.channelSecret),
});

const aiView = (ai: ConnectionCredential) => ({
  apiKeyConfigured: Boolean(ai.apiKey),
  model: ai.model ?? '',
  baseUrl: ai.baseUrl ?? (ai.apiKey ? LEGACY_AI_BASE_URL : ''),
});

/** The LINE and AI Connections of an Account: what is configured, never the secrets themselves. */
export const connectionRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/connections', accountRoute(async (request) => {
    const key = await request.key();
    const [line, ai] = await Promise.all([
      readConnection({ db: request.db, key, accountId: request.accountId, kind: 'line' }),
      readConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai' }),
    ]);
    return {
      accountId: request.accountId,
      accountName: request.account.name,
      line: { ...lineView(line), webhookUrl: lineWebhookUrl(request.env.APP_URL, request.accountId) },
      ai: aiView(ai),
    };
  }));

  routes.put('/organizations/:accountId/connections/line', accountRoute<{ channelAccessToken?: string; channelSecret?: string }>(async (request) => {
    const key = await request.key();
    const current = await readConnection({ db: request.db, key, accountId: request.accountId, kind: 'line' });
    const next: ConnectionCredential = { ...current, ...request.body };
    if (!next.channelAccessToken || !next.channelSecret) throw invalid('LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    await saveConnection({ db: request.db, key, accountId: request.accountId, kind: 'line', label: 'LINE Messaging API', credential: next });
    return { ...lineView(next), webhookUrl: lineWebhookUrl(request.env.APP_URL, request.accountId) };
  }));

  routes.put('/organizations/:accountId/connections/ai', accountRoute<{ apiKey?: string; model?: string; baseUrl?: string }>(async (request) => {
    const key = await request.key();
    const current = await readConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai' });
    const next: ConnectionCredential = { ...current, ...request.body };
    const baseUrl = normalizedAiBaseUrl(next.baseUrl);
    const model = next.model?.trim();
    if (!next.apiKey || !model || !baseUrl) throw invalid('OpenAI 互換 API の Base URL、model、API キーを入力してください。');
    if (model.length > 200) throw invalid('model は 200 文字以内で入力してください。');
    next.provider = 'OpenAI-compatible API';
    next.model = model;
    next.baseUrl = baseUrl;
    await saveConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai', label: 'OpenAI 互換 API', credential: next });
    return aiView(next);
  }));

  routes.post('/organizations/:accountId/connections/ai/test', accountRoute<{ prompt?: string }>(async (request) => {
    const prompt = request.body.prompt?.trim() ?? '';
    if (!prompt || prompt.length > 10_000) throw invalid('テスト用の質問は 1〜10,000 文字で入力してください。');
    const credential = await readConnection({ db: request.db, key: await request.key(), accountId: request.accountId, kind: 'ai' });
    const model = credential.model?.trim();
    const baseUrl = normalizedAiBaseUrl(credential.baseUrl || LEGACY_AI_BASE_URL);
    if (!credential.apiKey || !model || !baseUrl) throw conflict('OpenAI 互換 API を設定してください。');
    const response = await providers.fetch(openAiChatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await response.json() as OpenAiCompatibleResponse;
    if (!response.ok) throw upstream(body.error?.message ?? 'OpenAI 互換 API が応答しませんでした。');
    const text = generatedText(body);
    if (!text) throw upstream('OpenAI 互換 API からテキスト応答を受け取れませんでした。');
    return { text, model };
  }));

  return routes;
};
