import { requiredAiConnection } from '../ai';
import { resolveChatTools, runChatTurn, type ChatModelPort } from '../chat';
import { completeChatTurn } from '../chat-model';
import {
  chatHistory,
  chatInternalHandlers,
  closeChatTurn,
  ensureChatConversation,
  listChatConversations,
  listChatServers,
  openChatTurn,
  readChatTurns,
} from '../chat-store';
import { now } from '../clock';
import { ruleExecutionFor } from '../execution';
import type { Providers } from '../providers';
import { invalid, upstream } from '../refusal';
import { resource } from '../response';
import { accountRoute } from './account';

/** Operator Chat: each exchange recorded as one Rule Run of the Account's Rule Execution (ADR 0146, ADR 0168). */
export const chatRoutes = (providers: Providers) => {
  const routes = resource();
  const model: ChatModelPort = { complete: completeChatTurn };

  routes.get('/organizations/:accountId/chat', accountRoute(async ({ database }) => listChatConversations(database)));

  routes.get('/organizations/:accountId/chat/:conversationId', accountRoute(async ({ database, params }) =>
    readChatTurns({ database, conversationId: params.conversationId ?? '' })));

  routes.post('/organizations/:accountId/chat', accountRoute<{ conversationId?: string | null; message?: string }>(async (request) => {
    const message = request.body.message?.trim() ?? '';
    if (!message || message.length > 10_000) throw invalid('メッセージは 1〜10,000 文字で入力してください。');

    const { env, database, accountId } = request;
    const connection = await requiredAiConnection(env, accountId, database);
    const accountKey = await request.key();
    const servers = await listChatServers({ database, accountKey, accountId });
    const resolved = await resolveChatTools({ servers, fetch: providers.fetch, executionMode: 'unattended' });

    const conversationId = await ensureChatConversation({
      database,
      accountId,
      conversationId: request.body.conversationId ?? null,
      title: message,
      timestamp: now(),
    });
    const history = await chatHistory({ database, conversationId });
    const execution = ruleExecutionFor({ env, database, accountId, providers });
    const run = await execution.open({ intent: { kind: 'chat' } });
    const turn = await openChatTurn({ database, conversationId, ruleRunId: run.id, request: message, timestamp: now() });

    try {
      const result = await runChatTurn({
        model,
        connection,
        request: message,
        history,
        tools: resolved.tools,
        fetch: providers.fetch,
        internal: chatInternalHandlers(database),
      });
      await closeChatTurn({ database, turnId: turn.turnId, outcome: { status: 'completed', response: result.output }, timestamp: now() });
      await execution.close({ runId: run.id, outcome: 'completed' });
      return {
        conversationId,
        turnId: turn.turnId,
        ruleRunId: turn.ruleRunId,
        response: result.output,
        toolCallCount: result.toolCallCount,
        unreachableServers: resolved.failures,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Operator Chat turn failed.';
      await closeChatTurn({ database, turnId: turn.turnId, outcome: { status: 'failed', error: detail }, timestamp: now() });
      await execution.close({ runId: run.id, outcome: 'failed' });
      throw upstream(detail);
    }
  }));

  return routes;
};
