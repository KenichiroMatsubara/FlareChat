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

const MCP_PATH = '/api/public/organizations/organization-1/mcp';

const seedContact = (app_: TestApp, input: { id: string; name: string; destination: string }): void => {
  app_.account.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('${input.id}', 'organization-1', '${input.name}', '${input.id}@example.com', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
     VALUES ('dest-${input.id}', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), '${input.destination}', 'user', '${input.name}', 'discovered', 'manual', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at)
     VALUES ('${input.id}', 'dest-${input.id}', '2026-08-01T00:00:00.000Z')`,
  );
};

const connectLine = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/line',
    { channelAccessToken: 'line-token', channelSecret: 'line-secret' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const issueToken = async (app_: TestApp, input: { contactIds: string[]; tools?: string[]; window?: string; callsPerHour?: number }): Promise<string> => {
  const listed = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/contact-lists/list-1',
    { name: 'reachable', contactIds: input.contactIds },
    'PUT',
  ), app_.environment);
  expect(listed.status).toBe(200);
  const issued = await app.fetch(app_.jsonRequest('/api/organizations/organization-1/access-tokens', {
    name: 'cowork',
    contactListId: 'list-1',
    tools: input.tools ?? ['contacts.search', 'channel.send', 'reminder.schedule'],
    suppressionWindow: input.window ?? 'day',
    ...(input.callsPerHour ? { callsPerHour: input.callsPerHour } : {}),
  }), app_.environment);
  expect(issued.status).toBe(200);
  const body = await issued.json() as { data: { token: string } };
  return body.data.token;
};

const rpc = (app_: TestApp, token: string | null, body: unknown): Request =>
  new Request(`https://flarechat.example${MCP_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const stubLine = (ok = true): void => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: ok ? 200 : 500, headers: { 'x-line-request-id': 'line-1' } }));
};

describe('MCP Server endpoint', () => {
  it('refuses a caller that presents no Access Token', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(rpc(fixture, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('refuses a token this Account never issued', async () => {
    fixture = await createAutomationTestApp();

    const response = await app.fetch(rpc(fixture, 'not-a-real-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    expect(response.status).toBe(401);
  });

  it('lists only the tools the Token was granted', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'], tools: ['contacts.search'] });

    const response = await app.fetch(rpc(fixture, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), fixture.environment);

    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['contacts.search']);
  });

  it('reaches a Contact inside the bound list and records the delivery', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '明日9時です' } },
    }), fixture.environment);

    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]?.text).toContain('"delivered":true');
    expect(fixture.account.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries'))
      .toEqual([{ destination: 'U1', outcome: 'succeeded' }]);
  });

  it('refuses a Contact outside the bound list without reaching LINE', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    seedContact(fixture, { id: 'contact-2', name: '佐藤', destination: 'U2' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-2', channel: 'line', text: 'hi' } },
    }), fixture.environment);

    const body = await response.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 0 }]);
  });

  it('suppresses the same message sent again inside the window', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();
    const send = () => app.fetch(rpc(fixture as TestApp, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: '同じ内容' } },
    }), (fixture as TestApp).environment);

    await send();
    const second = await send();

    const body = await second.json() as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]?.text).toContain('suppressed');
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 1 }]);
  });

  it('stops a caller that has spent its hourly calls', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'], tools: ['contacts.search'], callsPerHour: 1 });
    const call = () => app.fetch(rpc(fixture as TestApp, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), (fixture as TestApp).environment);

    await call();
    const second = await call();

    expect(second.status).toBe(429);
  });

  it('schedules a reminder as a due Job rather than sending it now', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });
    stubLine();

    const response = await app.fetch(rpc(fixture, token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: '明日9時', at: '2099-01-01T00:00:00.000Z' } },
    }), fixture.environment);

    expect((await response.json() as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(fixture.account.rows<{ kind: string; available_at: string }>('SELECT kind, available_at FROM jobs'))
      .toEqual([{ kind: 'mcp.reminder', available_at: '2099-01-01T00:00:00.000Z' }]);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries')).toEqual([{ count: 0 }]);
  });

  it('never returns the issued credential again after it was shown once', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedContact(fixture, { id: 'contact-1', name: '田中', destination: 'U1' });
    const token = await issueToken(fixture, { contactIds: ['contact-1'] });

    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/access-tokens'), fixture.environment);

    expect(await listed.text()).not.toContain(token);
  });
});
