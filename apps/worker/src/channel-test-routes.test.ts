import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const connectLine = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/line',
    { channelAccessToken: 'line-token', channelSecret: 'line-secret' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const seedReachableContact = (app_: TestApp, input: { id: string; name: string; destination?: string }): void => {
  app_.account.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('${input.id}', 'organization-1', '${input.name}', '${input.id}@example.com', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  if (!input.destination) return;
  app_.account.execute(
    `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
     VALUES ('dest-${input.id}', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), '${input.destination}', 'user', '${input.name}', 'discovered', 'manual', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at)
     VALUES ('${input.id}', 'dest-${input.id}', '2026-08-01T00:00:00.000Z')`,
  );
};

const stubLine = (ok = true): void => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: ok ? 200 : 500, headers: { 'x-line-request-id': 'line-1' } }));
};

const sendTest = async (app_: TestApp, body: unknown): Promise<Response> =>
  await app.fetch(app_.jsonRequest('/api/organizations/organization-1/channel-tests', body), app_.environment);

describe('Channel Test send', () => {
  it('sends one arbitrary message and reports what LINE answered', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });
    stubLine();

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['テスト送信です'] });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { delivered: boolean; destination: string; externalId: string | null } };
    expect(body.data.delivered).toBe(true);
    expect(body.data.destination).toBe('U-one');
    expect(body.data.externalId).toBe('line-1');
    expect(fixture.account.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'line', outcome: 'succeeded' }]);
  });

  it('sends the same message twice, because a suppressed test proves nothing', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });
    stubLine();

    const first = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['同じ文面'] });
    const second = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['同じ文面'] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fixture.account.rows('SELECT id FROM deliveries')).toHaveLength(2);
  });

  it('reports a refusal as a failure rather than a delivery', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });
    stubLine(false);

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['テスト'] });

    expect(response.status).toBe(409);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('LINE');
    expect(fixture.account.rows('SELECT outcome FROM deliveries')).toEqual([{ outcome: 'failed' }]);
  });

  it('says the Contact holds no handle instead of sending nowhere', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎' });
    stubLine();

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['テスト'] });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { message: string } }).error.message).toContain('contact-1');
  });

  it('says the Account has no Connection when none is configured', async () => {
    fixture = await createAutomationTestApp();
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎' });

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['テスト'] });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { message: string } }).error.message).toContain('LINE');
  });

  it('carries up to five stated messages in one LINE request', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });
    const pushes: Array<{ messages: unknown[] }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      pushes.push(JSON.parse(String(init.body)) as { messages: unknown[] });
      return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-1' } });
    });

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['一', '二', '三', '四', '五'] });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { messages: number; requests: number } };
    expect(body.data).toMatchObject({ messages: 5, requests: 1 });
    expect(pushes).toHaveLength(1);
    expect(fixture.account.rows('SELECT id FROM deliveries')).toHaveLength(5);
  });

  it('refuses more messages than one request can carry', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['一', '二', '三', '四', '五', '六'] });

    expect(response.status).toBe(400);
  });

  it('refuses an empty message', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });

    const response = await sendTest(fixture, { contactId: 'contact-1', channel: 'line', texts: ['   '] });

    expect(response.status).toBe(400);
  });

  it('refuses a caller with no session', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });

    const response = await app.fetch(new Request('https://flarechat.example/api/organizations/organization-1/channel-tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: 'contact-1', channel: 'line', texts: ['テスト'] }),
    }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('offers only the Contacts a test message can actually reach', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedReachableContact(fixture, { id: 'contact-1', name: '一郎', destination: 'U-one' });
    seedReachableContact(fixture, { id: 'contact-2', name: '二郎' });

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/channel-tests/targets'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string; channels: string[] }> };
    expect(body.data).toEqual([{ id: 'contact-1', name: '一郎', email: 'contact-1@example.com', state: 'active', channels: ['line'] }]);
  });
});

describe('MCP Server test call', () => {
  const registerServer = async (app_: TestApp): Promise<void> => {
    const response = await app.fetch(app_.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/server-1',
      { name: 'line', url: 'https://line-mcp.example/mcp', token: 'server-token' },
      'PUT',
    ), app_.environment);
    expect(response.status).toBe(200);
  };

  const stubServer = (answer: (body: { method?: string; params?: { name?: string; arguments?: unknown } }) => unknown): void => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { id?: string; method?: string; params?: { name?: string; arguments?: unknown } };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result: answer(request) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
  };

  it('lists what a registered server offers', async () => {
    fixture = await createAutomationTestApp();
    await registerServer(fixture);
    stubServer(() => ({ tools: [{ name: 'push_text_message', description: 'Send a LINE message.', inputSchema: { type: 'object' } }] }));

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/server-1/tests',
      {},
    ), fixture.environment);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { server: string; tools: Array<{ name: string }> } };
    expect(body.data.server).toBe('line');
    expect(body.data.tools.map(({ name }) => name)).toEqual(['push_text_message']);
  });

  it('calls one tool with the arguments given and returns the server’s own answer', async () => {
    fixture = await createAutomationTestApp();
    await registerServer(fixture);
    const calls: unknown[] = [];
    stubServer((request) => {
      calls.push(request.params);
      return { content: [{ type: 'text', text: 'sent' }] };
    });

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/server-1/tests',
      { tool: 'push_text_message', arguments: { message: { type: 'text', text: 'テスト' } } },
    ), fixture.environment);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { isError: boolean; text: string } };
    expect(body.data).toMatchObject({ isError: false, text: 'sent' });
    expect(calls[0]).toMatchObject({ name: 'push_text_message', arguments: { message: { type: 'text', text: 'テスト' } } });
  });

  it('reports a tool that failed as failed', async () => {
    fixture = await createAutomationTestApp();
    await registerServer(fixture);
    stubServer(() => ({ isError: true, content: [{ type: 'text', text: 'invalid channel access token' }] }));

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/server-1/tests',
      { tool: 'push_text_message', arguments: {} },
    ), fixture.environment);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { isError: boolean; text: string } };
    expect(body.data.isError).toBe(true);
    expect(body.data.text).toContain('invalid channel access token');
  });

  it('refuses a server this Account never registered', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/absent/tests',
      {},
    ), fixture.environment);

    expect(response.status).toBe(404);
  });

  it('refuses arguments that are not a JSON object', async () => {
    fixture = await createAutomationTestApp();
    await registerServer(fixture);

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mcp-servers/server-1/tests',
      { tool: 'push_text_message', arguments: ['nope'] },
    ), fixture.environment);

    expect(response.status).toBe(400);
  });
});
