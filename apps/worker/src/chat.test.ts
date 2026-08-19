import { describe, expect, it } from 'vitest';

import { CHAT_INTERNAL_TOOLS, resolveChatTools, runChatTurn, type ChatModelPort, type ChatServer } from './chat';
import type { McpFetch } from './mcp';

const server = (name: string, url: string): ChatServer => ({ id: `${name}-1`, name, connection: { url } });

const listing = (tools: Array<{ name: string; description?: string }>): McpFetch => async (_url, init) => {
  const body = JSON.parse(String(init.body ?? '{}')) as { id?: string };
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: body.id,
    result: { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object', properties: {} } })) },
  }), { headers: { 'Content-Type': 'application/json' } });
};

const internalNames = CHAT_INTERNAL_TOOLS.map((tool) => tool.name);

describe('Operator Chat tool resolution', () => {
  it('gives an unattended chat every internal tool and every connected server tool', async () => {
    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }, { name: 'append' }]),
      executionMode: 'unattended',
    });

    expect(resolved.tools.map((tool) => tool.name)).toEqual([...internalNames, 'notion.search', 'notion.append']);
    expect(resolved.failures).toEqual([]);
  });

  it('binds no external tool at all in read-only mode', async () => {
    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }]),
      executionMode: 'read_only',
    });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(internalNames);
  });

  it('admits only the tools a grant names', async () => {
    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'search' }, { name: 'append' }]),
      executionMode: 'unattended',
      grant: ['notion.search'],
    });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(['notion.search']);
  });

  it('reports an unreachable server rather than quietly losing its tools', async () => {
    const failing: McpFetch = async () => new Response('gateway down', { status: 502 });

    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: failing,
      executionMode: 'unattended',
    });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(internalNames);
    expect(resolved.failures).toEqual([{ server: 'notion', error: expect.stringContaining('502') as unknown as string }]);
  });
});

const model = (turns: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: string }> }>): ChatModelPort => {
  let index = 0;
  return {
    complete: async () => {
      const turn = turns[index] ?? turns[turns.length - 1];
      index += 1;
      if (!turn) throw new Error('No stubbed chat completion.');
      return {
        model: 'test-model',
        content: turn.content,
        toolCalls: (turn.toolCalls ?? []).map((call, position) => ({ id: `call-${position}`, name: call.name, arguments: call.arguments })),
        totalTokens: 10,
      };
    },
  };
};

const connection = { apiKey: 'key', baseUrl: 'https://ai.example.com', model: 'test-model' };

describe('Operator Chat turn', () => {
  it('answers without calling a tool', async () => {
    const result = await runChatTurn({
      model: model([{ content: 'Nothing is scheduled.' }]),
      connection,
      request: 'What is scheduled?',
      history: [],
      tools: [],
      fetch: listing([]),
      internal: { query_scheduled_events: async () => [] },
    });

    expect(result.output).toBe('Nothing is scheduled.');
    expect(result.toolCallCount).toBe(0);
  });

  it('calls an MCP tool and hands the model its real result', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { id?: string; params?: Record<string, unknown> };
      calls.push(body.params ?? {});
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'page created' }] },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'append' }]),
      executionMode: 'unattended',
      grant: ['notion.append'],
    });

    const result = await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'notion.append', arguments: '{"text":"hello"}' }] },
        { content: 'Added it.' },
      ]),
      connection,
      request: 'Append hello to Notion.',
      history: [],
      tools: resolved.tools,
      fetch,
      internal: {},
    });

    expect(result.output).toBe('Added it.');
    expect(calls[0]).toMatchObject({ name: 'append', arguments: { text: 'hello' } });
    expect(result.messages.some((message) => message.role === 'tool' && message.content.includes('page created'))).toBe(true);
  });

  it('shows the model a failed tool call as a failure', async () => {
    const fetch: McpFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { id?: string };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { isError: true, content: [{ type: 'text', text: 'permission denied' }] },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const resolved = await resolveChatTools({
      servers: [server('notion', 'https://notion.example.com/mcp')],
      fetch: listing([{ name: 'append' }]),
      executionMode: 'unattended',
    });

    const result = await runChatTurn({
      model: model([
        { content: '', toolCalls: [{ name: 'notion.append', arguments: '{}' }] },
        { content: 'It refused.' },
      ]),
      connection,
      request: 'Append.',
      history: [],
      tools: resolved.tools,
      fetch,
      internal: {},
    });

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('permission denied');
    expect(toolMessage?.content).toContain('"isError":true');
  });

  it('refuses a tool the resolved set does not contain', async () => {
    await expect(runChatTurn({
      model: model([{ content: '', toolCalls: [{ name: 'notion.delete', arguments: '{}' }] }]),
      connection,
      request: 'Delete everything.',
      history: [],
      tools: [],
      fetch: listing([]),
      internal: {},
    })).rejects.toThrow(/notion\.delete/u);
  });

  it('stops a turn that exceeds its tool-call ceiling', async () => {
    const resolved = await resolveChatTools({
      servers: [server('loop', 'https://loop.example.com/mcp')],
      fetch: listing([{ name: 'again' }]),
      executionMode: 'unattended',
    });
    const alwaysCalls = model([{ content: '', toolCalls: [{ name: 'loop.again', arguments: '{}' }] }]);
    const fetch: McpFetch = async (_url, init) => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: (JSON.parse(String(init.body ?? '{}')) as { id?: string }).id,
      result: { content: [{ type: 'text', text: 'again' }] },
    }), { headers: { 'Content-Type': 'application/json' } });

    await expect(runChatTurn({
      model: alwaysCalls,
      connection,
      request: 'Loop.',
      history: [],
      tools: resolved.tools,
      fetch,
      internal: {},
    })).rejects.toThrow(/tool-call/u);
  });

  it('carries earlier exchanges into the next turn', async () => {
    let seen: string[] = [];
    const recording: ChatModelPort = {
      complete: async (request) => {
        seen = request.messages.map((message) => message.content);
        return { model: 'test-model', content: 'ok', toolCalls: [], totalTokens: 1 };
      },
    };

    await runChatTurn({
      model: recording,
      connection,
      request: 'And the one after that?',
      history: [{ role: 'user', content: 'What is next?' }, { role: 'assistant', content: 'The AGM.' }],
      tools: [],
      fetch: listing([]),
      internal: {},
    });

    expect(seen).toContain('What is next?');
    expect(seen).toContain('The AGM.');
    expect(seen.at(-1)).toBe('And the one after that?');
  });
});
