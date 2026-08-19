/** OpenAI-compatible adapter for one Operator Chat exchange, using the Account's own AI Connection. */

import { openAiChatCompletionsUrl } from './event-details';
import type { ChatMessage, ChatModelCompletion, ChatModelRequest } from './chat';

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

const wireMessage = (message: ChatMessage): Record<string, unknown> => ({
  role: message.role,
  content: message.content,
  ...(message.name ? { name: message.name } : {}),
  ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  ...(message.toolCalls
    ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
    : {}),
});

export const completeChatTurn = async (request: ChatModelRequest): Promise<ChatModelCompletion> => {
  const response = await fetch(openAiChatCompletionsUrl(request.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map(wireMessage),
      ...(request.tools.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
    }),
  });
  const body = await response.json() as OpenAiChatResponse;
  if (!response.ok) throw new Error(`OpenAI 互換 API: ${body.error?.message?.trim() || `HTTP ${response.status}`}`);
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error('OpenAI 互換 API returned no Operator Chat message.');
  return {
    model: body.model ?? request.model,
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? crypto.randomUUID(),
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    })),
    totalTokens: body.usage?.total_tokens ?? 0,
  };
};
