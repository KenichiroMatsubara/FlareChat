import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const connectAi = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/ai',
    { apiKey: 'ai-key', baseUrl: 'https://ai.example.com', model: 'test-model' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const connectServer = async (app_: TestApp, input: { id: string; name: string; url: string; token?: string }): Promise<Response> =>
  app.fetch(app_.jsonRequest(
    `/api/organizations/organization-1/mcp-servers/${input.id}`,
    { name: input.name, url: input.url, token: input.token ?? null },
    'PUT',
  ), app_.environment);

/** Answers the AI endpoint from a scripted list of turns and every MCP endpoint with one tool. */
const stubProviders = (turns: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: string }> }>, mcp?: {
  tools?: string[];
  call?: () => Response;
}): void => {
  let index = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('ai.example.com')) {
      const turn = turns[index] ?? turns[turns.length - 1];
      index += 1;
      return new Response(JSON.stringify({
        model: 'test-model',
        choices: [{
          message: {
            content: turn?.content ?? '',
            tool_calls: (turn?.toolCalls ?? []).map((call, position) => ({
              id: `call-${position}`,
              function: { name: call.name, arguments: call.arguments },
            })),
          },
        }],
        usage: { total_tokens: 5 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; method?: string };
    if (body.method === 'tools/list') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: (mcp?.tools ?? []).map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return mcp?.call?.() ?? new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: 'done' }] },
    }), { headers: { 'Content-Type': 'application/json' } });
  });
};

describe('MCP Server registration', () => {
  it('never returns the bearer token it was given', async () => {
    fixture = await createAutomationTestApp();
    expect((await connectServer(fixture, { id: 'server-1', name: 'notion', url: 'https://notion.example.com/mcp', token: 'secret' })).status).toBe(200);

    const response = await app.fetch(fixture.request('/api/organizations/organization-1/mcp-servers'), fixture.environment);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('secret');
    expect(JSON.parse(body)).toMatchObject({ data: [{ name: 'notion', url: 'https://notion.example.com/mcp', authenticated: true }] });
  });

  it('refuses a server that is not reached over https', async () => {
    fixture = await createAutomationTestApp();

    const response = await connectServer(fixture, { id: 'server-1', name: 'notion', url: 'http://notion.example.com/mcp' });

    expect(response.status).toBe(400);
  });

  it('refuses a name that could not be used to namespace a tool', async () => {
    fixture = await createAutomationTestApp();

    const response = await connectServer(fixture, { id: 'server-1', name: 'my server', url: 'https://notion.example.com/mcp' });

    expect(response.status).toBe(400);
  });
});

describe('Operator Chat', () => {
  it('records one exchange as one Rule Run of chat intent', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    stubProviders([{ content: '来週の予定は2件です。' }]);

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { message: '来週の予定は?' },
    ), fixture.environment);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { conversationId: string; response: string; ruleRunId: string } };
    expect(body.data.response).toBe('来週の予定は2件です。');

    expect(fixture.account.rows<{ intent: string; status: string; source_message_id: string | null }>(
      'SELECT intent, status, source_message_id FROM rule_runs',
    )).toEqual([{ intent: 'chat', status: 'completed', source_message_id: null }]);
    expect(fixture.account.rows<{ status: string; response: string }>(
      'SELECT status, response FROM chat_turns',
    )).toEqual([{ status: 'completed', response: '来週の予定は2件です。' }]);
  });

  it('continues the same conversation on the next exchange', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    stubProviders([{ content: '2件です。' }]);
    const first = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/chat', { message: '予定は?' }), fixture.environment);
    const { data } = await first.json() as { data: { conversationId: string } };

    stubProviders([{ content: 'どちらも来週です。' }]);
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { conversationId: data.conversationId, message: 'いつ?' },
    ), fixture.environment);

    expect(second.status).toBe(200);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM chat_conversations')).toEqual([{ count: 1 }]);
    expect(fixture.account.rows<{ position: number }>('SELECT position FROM chat_turns ORDER BY position')).toEqual([{ position: 1 }, { position: 2 }]);
  });

  it('calls a connected MCP Server tool during an exchange', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    await connectServer(fixture, { id: 'server-1', name: 'notion', url: 'https://notion.example.com/mcp' });
    stubProviders(
      [{ content: '', toolCalls: [{ name: 'notion.append', arguments: '{"text":"hi"}' }] }, { content: '書き込みました。' }],
      { tools: ['append'] },
    );

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { message: 'Notion に書いて' },
    ), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { response: '書き込みました。', toolCallCount: 1 } });
  });

  it('keeps the failed exchange rather than losing what was asked', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'model unavailable' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { message: '予定は?' },
    ), fixture.environment);

    expect(response.status).toBe(503);
    expect(fixture.account.rows<{ status: string; request: string }>('SELECT status, request FROM chat_turns'))
      .toEqual([{ status: 'failed', request: '予定は?' }]);
    expect(fixture.account.rows<{ status: string }>("SELECT status FROM rule_runs WHERE intent = 'chat'"))
      .toEqual([{ status: 'failed' }]);
  });

  it('names a server it could not reach instead of answering as though it had every tool', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    await connectServer(fixture, { id: 'server-1', name: 'notion', url: 'https://notion.example.com/mcp' });
    let index = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('ai.example.com')) {
        index += 1;
        return new Response(JSON.stringify({
          model: 'test-model',
          choices: [{ message: { content: index === 1 ? 'Notion は今使えません。' : '' } }],
          usage: { total_tokens: 5 },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('gateway down', { status: 502 });
    });

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { message: 'Notion に書いて' },
    ), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { unreachableServers: [{ server: 'notion' }] },
    });
  });

  it('requires an AI Connection before it will start', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/chat',
      { message: '予定は?' },
    ), fixture.environment);

    expect(response.status).toBe(409);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM chat_turns')).toEqual([{ count: 0 }]);
  });
});
