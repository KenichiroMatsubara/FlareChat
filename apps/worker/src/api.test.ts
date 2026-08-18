import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { enqueueJob } from './jobs';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import {
  seedAttendanceRegistration,
  seedAutomationException,
  seedAutomationRule,
  seedDeliveryRecord,
  seedAccountContact,
  seedScheduledEvent,
} from '../test/seed';

let fixture: TestApp | undefined;

const backgroundExecution = () => {
  const tasks: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil: (task: Promise<unknown>) => { tasks.push(task); },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    settle: async (): Promise<void> => { await Promise.all(tasks); },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

describe('Account access', () => {
  it('returns Automation Inbox behavior from the selected Account', async () => {
    fixture = createTestApp();

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', displayName: 'Owner', enabled: true },
    });
  });

  it('never falls back to another database when an Account binding is unavailable', async () => {
    fixture = createTestApp();
    delete (fixture.environment as unknown as Record<string, unknown>).ORG_ORGANIZATION1;

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/connections'),
      fixture.environment,
    );

    expect(response.status).toBe(503);
  });

  it('keeps management data isolated between two Accounts', async () => {
    fixture = createTestApp();
    fixture.addAccount({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2' });
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-2/lists',
      { kind: 'source', name: 'Account Two Sources' },
    ), fixture.environment);

    const first = await app.fetch(
      fixture.request('/api/organizations/organization-1/lists'),
      fixture.environment,
    );
    const second = await app.fetch(
      fixture.request('/api/organizations/organization-2/lists'),
      fixture.environment,
    );

    expect(created.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ data: [] });
    await expect(second.json()).resolves.toMatchObject({
      data: [{ name: 'Account Two Sources' }],
    });
  });

  it('lets the one Account of an Account read outcomes and make management changes', async () => {
    fixture = createTestApp();

    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    const listChange = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/lists',
      { kind: 'source', name: 'Allowed' },
    ), fixture.environment);
    const contactChange = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Allowed', email: 'allowed@example.com' },
    ), fixture.environment);

    expect(dashboard.status).toBe(200);
    expect(listChange.status).toBe(201);
    expect(contactChange.status).toBe(201);
  });
});

describe('Account connections', () => {
  it('stores a LINE Connection without requiring an AI Connection', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/line',
      {
        channelAccessToken: 'line-token',
        channelSecret: 'line-secret',
      },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        channelAccessTokenConfigured: true,
        channelSecretConfigured: true,
        webhookUrl: 'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      },
    });

    const connections = await app.fetch(fixture.request(
      '/api/organizations/organization-1/connections',
    ), fixture.environment);
    await expect(connections.json()).resolves.toMatchObject({
      data: {
        line: {
          channelAccessTokenConfigured: true,
          channelSecretConfigured: true,
          webhookUrl: 'https://app.example.com/api/public/organizations/organization-1/line/webhook',
        },
        ai: { apiKeyConfigured: false },
      },
    });
  });
});

describe('OpenAI-compatible connection', () => {
  it('stores an arbitrary HTTPS Base URL and model and uses them for the connection test', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai',
      {
        baseUrl: 'https://gateway.example.com/openai/v1/',
        model: 'organization-model',
        apiKey: 'organization-api-key',
      },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        apiKeyConfigured: true,
        baseUrl: 'https://gateway.example.com/openai/v1',
        model: 'organization-model',
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '接続成功' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tested = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai/test',
      { prompt: '接続を確認' },
    ), fixture.environment);

    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({
      data: { text: '接続成功', model: 'organization-model' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.com/openai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer organization-api-key' }),
        body: expect.stringContaining('"model":"organization-model"'),
      }),
    );
  });

  it('rejects an insecure Base URL before storing credentials', async () => {
    fixture = await createAutomationTestApp();
    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai',
      {
        baseUrl: 'http://ai.example.com/v1',
        model: 'organization-model',
        apiKey: 'organization-api-key',
      },
      'PUT',
    ), fixture.environment);

    expect(response.status).toBe(400);
  });
});

describe('Account management', () => {
  it('creates and reads canonical Typed Lists and List Items', async () => {
    fixture = createTestApp();
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/lists',
      { kind: 'source', name: 'Contacts', description: 'Verified senders' },
    ), fixture.environment);
    const createdBody = await created.json() as { data: { id: string } };
    const item = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/lists/${createdBody.data.id}/items`,
      { value: 'sender@example.com', label: 'Sender' },
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/lists'),
      fixture.environment,
    );

    expect(created.status).toBe(201);
    expect(item.status).toBe(201);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{ kind: 'source', name: 'Contacts' }],
    });
  });

  it('rejects removed Typed List compatibility names', async () => {
    fixture = createTestApp();

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/lists',
      { kind: 'calendar_recipient', name: 'Legacy' },
    ), fixture.environment);

    expect(response.status).toBe(400);
  });

  it('creates a Draft unattended Schema Rule and revisions its Execution Mode independently of activation', async () => {
    fixture = createTestApp();
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/rules',
      {
        name: 'Announcements',
        selectionPolicy: { source: 'trusted' },
        routingPolicy: { calendar: true },
      },
    ), fixture.environment);
    const body = await created.json() as { data: { id: string } };
    const modeUpdated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/rules/${body.data.id}`,
      { executionMode: 'read_only' },
      'PATCH',
    ), fixture.environment);
    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/rules/${body.data.id}`,
      { state: 'active' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/rules'),
      fixture.environment,
    );

    expect([created.status, modeUpdated.status, updated.status]).toEqual([201, 200, 200]);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{
        id: body.data.id,
        name: 'Announcements',
        state: 'active',
        executionMode: 'read_only',
        revision: 2,
        selectionPolicy: { source: 'trusted' },
      }],
    });
  });

  it('offers Contacts rather than the shared Google account of an Account as Task assignees', async () => {
    fixture = createTestApp();
    const role = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '会計', description: '支払期限を扱う',
    }), fixture.environment);
    const roleId = (await role.json() as { data: { id: string } }).data.id;
    const contact = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/members', {
      name: '山田花子', email: 'hanako@example.com',
    }), fixture.environment);
    const contactId = (await contact.json() as { data: { id: string } }).data.id;

    const assigned = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/task-roles/${roleId}/assignment`,
      { contactId },
      'PUT',
    ), fixture.environment);
    const configuration = await app.fetch(
      fixture.request('/api/organizations/organization-1/task-roles'),
      fixture.environment,
    );

    expect(assigned.status).toBe(200);
    await expect(configuration.json()).resolves.toMatchObject({
      data: {
        contacts: [{ contactId, displayName: '山田花子' }],
        assignments: [{ roleId, contactId, displayName: '山田花子' }],
      },
    });
  });

  it('refuses a Task assignee that is not an active Contact of the Account', async () => {
    fixture = createTestApp();
    const role = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '会計', description: '支払期限を扱う',
    }), fixture.environment);
    const roleId = (await role.json() as { data: { id: string } }).data.id;

    const assigned = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/task-roles/${roleId}/assignment`,
      { contactId: 'identity-1' },
      'PUT',
    ), fixture.environment);

    expect(assigned.status).toBe(409);
  });

  it('stores the Account role subset an Automation Rule may assign', async () => {
    fixture = createTestApp();
    const first = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '参加登録担当', description: '申込期限を扱う',
    }), fixture.environment);
    const second = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '支払担当', description: '支払期限を扱う',
    }), fixture.environment);
    const firstId = (await first.json() as { data: { id: string } }).data.id;
    const secondId = (await second.json() as { data: { id: string } }).data.id;

    const created = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/rules', {
      name: 'Registration only', state: 'active', taskRoleIds: [firstId],
    }), fixture.environment);
    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/rules'), fixture.environment);
    const listedText = await listed.clone().text();

    expect(created.status).toBe(201);
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      name: 'Registration only', taskRoleIds: [firstId],
    }] });
    expect(listedText).not.toContain(secondId);
  });

  it('creates an Automation Rule with permitted Calendar Recipient and LINE Destination List sets', async () => {
    fixture = createTestApp();
    const recipientOne = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'recipient', name: 'Contacts',
    }), fixture.environment);
    const recipientTwo = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'recipient', name: 'Guests',
    }), fixture.environment);
    const lineOne = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'line', name: 'Contact LINE',
    }), fixture.environment);
    const lineTwo = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'line', name: 'Guest LINE',
    }), fixture.environment);
    const recipientListIds = await Promise.all([recipientOne, recipientTwo].map(async (response) =>
      (await response.json() as { data: { id: string } }).data.id));
    const lineListIds = await Promise.all([lineOne, lineTwo].map(async (response) =>
      (await response.json() as { data: { id: string } }).data.id));

    const created = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/rules', {
      name: 'Permitted destinations',
      permittedRecipientListIds: [...recipientListIds, recipientListIds[0]],
      permittedLineListIds: [...lineListIds, lineListIds[0]],
    }), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/rules'),
      fixture.environment,
    );

    expect(created.status).toBe(201);
    const listedBody = await listed.json() as { data: Array<{
      name: string;
      permittedRecipientListIds: string[];
      permittedLineListIds: string[];
    }> };
    expect(listedBody.data[0]).toMatchObject({
      name: 'Permitted destinations',
      permittedRecipientListIds: expect.arrayContaining(recipientListIds),
      permittedLineListIds: expect.arrayContaining(lineListIds),
    });
    expect(listedBody.data[0]?.permittedRecipientListIds).toHaveLength(2);
    expect(listedBody.data[0]?.permittedLineListIds).toHaveLength(2);
  });

  it('adds and removes permitted destination lists through the Automation Rule interface', async () => {
    fixture = createTestApp();
    const firstList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'recipient', name: 'Current readers',
    }), fixture.environment);
    const secondList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
      kind: 'recipient', name: 'New readers',
    }), fixture.environment);
    const firstListId = (await firstList.json() as { data: { id: string } }).data.id;
    const secondListId = (await secondList.json() as { data: { id: string } }).data.id;
    const created = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/rules', {
      name: 'Editable blast radius', permittedRecipientListIds: [firstListId],
    }), fixture.environment);
    const ruleId = (await created.json() as { data: { id: string } }).data.id;

    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/rules/${ruleId}`,
      { permittedRecipientListIds: [secondListId], permittedLineListIds: [] },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/rules'),
      fixture.environment,
    );

    expect(updated.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      id: ruleId,
      permittedRecipientListIds: [secondListId],
      permittedLineListIds: [],
    }] });
  });

  it('creates, revises, lists, and deletes an Account Prompt', async () => {
    fixture = createTestApp();
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/prompts',
      { name: 'Event analyst', instructions: 'Read the Source Message.' },
    ), fixture.environment);
    const createdBody = await created.json() as { data: { id: string } };
    const revised = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/prompts/${createdBody.data.id}`,
      { instructions: 'Read the Source Message and report deadlines.' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/prompts'),
      fixture.environment,
    );
    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/prompts/${createdBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/prompts'),
      fixture.environment,
    );

    expect([created.status, revised.status, removed.status]).toEqual([201, 200, 200]);
    await expect(revised.json()).resolves.toMatchObject({
      data: { id: createdBody.data.id, revision: 2 },
    });
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      id: createdBody.data.id,
      name: 'Event analyst',
      instructions: 'Read the Source Message and report deadlines.',
      revision: 2,
    }] });
    await expect(afterRemoval.json()).resolves.toEqual({ data: [] });
  });

  it('creates a Draft unattended Agent Rule by default and exposes its configurable Execution Mode', async () => {
    fixture = createTestApp();
    const prompt = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/prompts',
      { name: 'Event analyst', instructions: 'Read the Source Message.' },
    ), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/agent-rules',
      { name: 'Trusted analyst', promptId, selectionPolicy: { domain: 'example.com' } },
    ), fixture.environment);
    const createdBody = await created.json() as { data: { id: string; executionMode: string } };
    const agentRuleId = createdBody.data.id;
    const unattended = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/agent-rules/${agentRuleId}`,
      { executionMode: 'read_only' },
      'PATCH',
    ), fixture.environment);
    const suspended = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/agent-rules/${agentRuleId}`,
      { state: 'active' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/agent-rules'),
      fixture.environment,
    );

    expect([created.status, unattended.status, suspended.status]).toEqual([201, 200, 200]);
    expect(createdBody.data.executionMode).toBe('unattended');
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      id: agentRuleId,
      name: 'Trusted analyst',
      promptId,
      state: 'active',
      selectionPolicy: { domain: 'example.com' },
      executionMode: 'read_only',
      revision: 2,
    }] });
  });

  it('stores Agent Rule permitted recipient and LINE destination candidate sets', async () => {
    fixture = createTestApp();
    const recipientList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'recipient', name: 'Guests' }), fixture.environment);
    const lineList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'line', name: 'Guest LINE' }), fixture.environment);
    const recipientListId = (await recipientList.json() as { data: { id: string } }).data.id;
    const lineListId = (await lineList.json() as { data: { id: string } }).data.id;
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', { name: 'Writer', instructions: 'Act.' }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;

    const created = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Writer', promptId, permittedRecipientListIds: [recipientListId], permittedLineListIds: [lineListId],
    }), fixture.environment);
    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/agent-rules'), fixture.environment);

    expect(created.status).toBe(201);
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      name: 'Writer', executionMode: 'unattended', permittedRecipientListIds: [recipientListId], permittedLineListIds: [lineListId],
    }] });
  });

  it('shows the guests of an upcoming Scheduled Event and leaves a finished one out', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, {
      id: 'event-upcoming', title: '例会', startsAt: '2999-08-03T19:00:00+09:00', endsAt: '2999-08-03T21:00:00+09:00',
    });
    seedScheduledEvent(fixture.account, {
      id: 'event-past', title: '前回の例会', startsAt: '2020-08-03T19:00:00+09:00', endsAt: '2020-08-03T21:00:00+09:00',
    });
    fixture.account.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('response-1', 'gmail-1', 'history-1', 'chair@example.com', 'Re: 例会', '2026-08-01', 'processed')",
    );
    const guest = (id: string, eventId: string, name: string, affiliation: string, attending: number): void =>
      fixture!.account.execute(
        'INSERT INTO guest_registrations (id, event_id, source_message_id, name, affiliation, attending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, eventId, 'response-1', name, affiliation, attending, '2026-08-01',
      );
    guest('guest-1', 'event-upcoming', '山田太郎', '北クラブ', 1);
    guest('guest-2', 'event-upcoming', '鈴木花子', '北クラブ', 1);
    guest('guest-3', 'event-upcoming', '佐藤一郎', '南クラブ', 0);
    guest('guest-4', 'event-past', '過去太郎', '北クラブ', 1);

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/guest-registrations'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{
        eventId: 'event-upcoming',
        title: '例会',
        startsAt: '2999-08-03T19:00:00+09:00',
        attendingCount: 2,
        affiliations: [{ affiliation: '北クラブ', attending: 2 }],
        guests: [
          { name: '佐藤一郎', affiliation: '南クラブ', attending: false },
          { name: '山田太郎', affiliation: '北クラブ', attending: true },
          { name: '鈴木花子', affiliation: '北クラブ', attending: true },
        ],
      }],
    });
  });

  it('creates, changes, imports, reads, and snapshots Contacts', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1' });
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const body = await created.json() as { data: { id: string } };
    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${body.data.id}`,
      { tags: ['vip'], state: 'active' },
      'PATCH',
    ), fixture.environment);
    const imported = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members/import',
      { csv: 'name,email\nSecond,second@example.com\nInvalid,not-an-email' },
    ), fixture.environment);
    const snapshotted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1/recipient-snapshots',
      { contactIds: [body.data.id] },
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect([created.status, updated.status, imported.status, snapshotted.status]).toEqual([201, 200, 201, 201]);
    await expect(snapshotted.json()).resolves.toMatchObject({ data: { snapshotted: 1 } });
    await expect(listed.json()).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'Guest', email: 'guest@example.com', tags: ['vip'] }),
        expect.objectContaining({ name: 'Second', email: 'second@example.com' }),
      ]),
    });
  });

  it('creates multiple Contacts without email and allows email to be edited later', async () => {
    fixture = createTestApp();
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'メール未設定 一郎' },
    ), fixture.environment);
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'メール未設定 二郎' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string; email: string } };
    const setEmail = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}`,
      { email: 'later@example.com' },
      'PATCH',
    ), fixture.environment);
    const clearEmail = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}`,
      { email: '' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect([first.status, second.status, setEmail.status, clearEmail.status]).toEqual([201, 201, 200, 200]);
    expect(firstBody.data.email).toBe('');
    await expect(listed.json()).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'メール未設定 一郎', email: '' }),
        expect.objectContaining({ name: 'メール未設定 二郎', email: '' }),
      ]),
    });
  });

  it('builds dashboard counts from durable Account behavior', async () => {
    fixture = createTestApp();
    seedAutomationRule(fixture.account, { id: 'rule-1' });
    seedScheduledEvent(fixture.account, { id: 'event-1' });
    seedAutomationException(fixture.account, { id: 'exception-1' });
    await enqueueJob(fixture.account.binding, {
      kind: 'sync',
      payload: {},
      idempotencyKey: 'job-key-1',
    });

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );

    await expect(response.json()).resolves.toMatchObject({
      data: { activeRules: 1, upcomingEvents: 1, pendingJobs: 1, exceptions: 1 },
    });
  });
});

describe('Control-plane administration', () => {
  it('records one Owner recovery request per idempotency key', async () => {
    fixture = createTestApp();

    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recovery-requests',
      { idempotencyKey: 'receipt-1' },
    ), fixture.environment);
    const duplicate = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recovery-requests',
      { idempotencyKey: 'receipt-1' },
    ), fixture.environment);

    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      data: { accountId: 'organization-1', idempotencyKey: 'receipt-1', state: 'requested' },
    });
    expect(duplicate.status).toBe(409);
  });
});

describe('Operational outcomes', () => {
  it('exposes Event changes, Delivery Records, and Exception transitions through operations interfaces', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1', status: 'draft' });
    seedDeliveryRecord(fixture.account, {
      id: 'delivery-1',
      eventId: 'event-1',
      destination: 'guest@example.com',
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    seedDeliveryRecord(fixture.account, {
      id: 'delivery-line',
      eventId: 'event-1',
      destination: 'Udelivery0000000000000000000000000',
      channel: 'line',
      createdAt: '2026-07-26T00:00:00.000Z',
    });
    seedAutomationException(fixture.account, { id: 'exception-1' });

    const event = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1',
      { title: 'New title', status: 'scheduled', reason: 'Correction' },
      'PATCH',
    ), fixture.environment);
    const exception = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/operations/exceptions/exception-1',
      { action: 'resolve' },
      'PATCH',
    ), fixture.environment);
    const audit = await app.fetch(
      fixture.request('/api/organizations/organization-1/audit/deliveries'),
      fixture.environment,
    );
    const operations = await app.fetch(
      fixture.request('/api/organizations/organization-1/operations/exceptions'),
      fixture.environment,
    );
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );

    expect([event.status, exception.status, audit.status]).toEqual([200, 200, 200]);
    const auditBody = await audit.json();
    expect(auditBody).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ destination: 'guest@example.com', outcome: 'succeeded' }),
        expect.objectContaining({ destination: 'Udeli…', outcome: 'succeeded' }),
      ]),
    });
    expect(JSON.stringify(auditBody)).not.toContain('Udelivery0000000000000000000000000');
    await expect(operations.json()).resolves.toMatchObject({
      data: [{ id: 'exception-1', state: 'resolved' }],
    });
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 1, exceptions: 0 },
    });
  });
});

describe('LINE destinations', () => {
  it('acknowledges a valid webhook without waiting for LINE profile lookup', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'U1234567890' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    let releaseProfile!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { releaseProfile = resolve; })));
    const background = backgroundExecution();
    const responsePromise = Promise.resolve(app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context));
    const outcome = await Promise.race([
      responsePromise.then(() => 'acknowledged'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    releaseProfile(new Response(JSON.stringify({ displayName: '山田 太郎' }), { status: 200 }));
    const response = await responsePromise;
    await background.settle();

    expect(outcome).toBe('acknowledged');
    expect(response.status).toBe(200);
  });

  it('captures a LINE display name and assigns the discovered ID to a Contact', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const profileFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      displayName: '山田 太郎',
    }), { status: 200 }));
    vi.stubGlobal('fetch', profileFetch);
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'U1234567890' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');

    const background = backgroundExecution();
    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{
      id: string;
      destinationId: string;
      source: string;
      contactId: string | null;
    }> };
    expect(destinationsBody.data[0]).toMatchObject({
      destinationId: 'U1234…',
      source: 'webhook',
      contactId: null,
    });
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      {
        name: '山田 太郎',
        email: 'taro@example.com',
        tags: ['ロータリー'],
        lineDestinationId: destinationsBody.data[0]?.id,
      },
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(webhook.status).toBe(200);
    expect(recipient.status).toBe(201);
    expect(profileFetch).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/profile/U1234567890',
      { headers: { Authorization: 'Bearer line-token' } },
    );
    await expect(roster.json()).resolves.toMatchObject({
      data: [{
        name: '山田 太郎',
        email: 'taro@example.com',
        tags: ['ロータリー'],
        lineDestinations: [{
          destinationId: 'U1234…',
          displayName: '山田 太郎',
          kind: 'user',
        }],
      }],
    });
  });

  it('verifies a webhook, discovers a destination, and consumes its Contact Link once', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'group', groupId: 'group-1' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    const background = backgroundExecution();
    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };
    const issued = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-links`,
      {},
    ), fixture.environment);
    const issuedBody = await issued.json() as { data: { token: string } };
    const linkPath = `/api/public/organizations/organization-1/line-links/${issuedBody.data.token}`;
    const consumed = await app.fetch(fixture.jsonRequest(linkPath, { destinationId: 'group-1' }), fixture.environment);
    const duplicate = await app.fetch(fixture.jsonRequest(linkPath, { destinationId: 'group-1' }), fixture.environment);

    await expect(webhook.json()).resolves.toMatchObject({ data: { discovered: 1 } });
    expect(recipient.status).toBe(201);
    expect(issued.status).toBe(201);
    await expect(consumed.json()).resolves.toMatchObject({
      data: { contactId: recipientBody.data.id, destinationId: 'group…' },
    });
    expect(duplicate.status).toBe(410);
  });

  it('lets an Owner manually attach, correct, and unlink a LINE ID without a webhook event', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '手動 太郎', email: 'manual@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const attached = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Umanualtypo0000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const attachedBody = await attached.json() as { data: { id: string } };

    const corrected = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Ucorrected0000000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(attached.status).toBe(201);
    expect(corrected.status).toBe(201);
    await expect(roster.json()).resolves.toMatchObject({
      data: [{
        id: recipientBody.data.id,
        lineDestinations: [{
          destinationId: 'Ucorr…',
          displayName: '手動 太郎',
          kind: 'user',
          source: 'manual',
        }],
      }],
    });

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${attachedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    expect(unlinked.status).toBe(404);

    const correctedBody = await corrected.json() as { data: { id: string } };
    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${correctedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(removed.status).toBe(200);
    await expect(afterRemoval.json()).resolves.toMatchObject({
      data: [{ id: recipientBody.data.id, lineDestinations: [] }],
    });
  });

  it('rejects a manually entered LINE ID that is already linked to a different member', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Contact One', email: 'one@example.com' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string } };
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Contact Two', email: 'two@example.com' },
    ), fixture.environment);
    const secondBody = await second.json() as { data: { id: string } };
    await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}/line-destination`,
      { destinationId: 'Ushared00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    const conflict = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${secondBody.data.id}/line-destination`,
      { destinationId: 'Ushared00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    expect(conflict.status).toBe(409);
  });

  it('keeps a webhook-discovered destination available for reassignment after it is unlinked', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'Uwebhook0000000000000000000000000' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    const background = backgroundExecution();
    await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{ id: string }> };
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Discovered', email: 'discovered@example.com', lineDestinationId: destinationsBody.data[0]?.id },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${destinationsBody.data[0]?.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const stillDiscovered = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(unlinked.status).toBe(200);
    await expect(stillDiscovered.json()).resolves.toMatchObject({
      data: [{ id: destinationsBody.data[0]?.id, contactId: null, source: 'webhook' }],
    });
  });

  it('registers a bare LINE ID into the pending pool and lets it be removed before it is promoted', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });

    const registered = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upending00000000000000000000000000', displayName: '保留 太郎' },
      'POST',
    ), fixture.environment);
    const registeredBody = await registered.json() as { data: { id: string } };
    const pending = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(registered.status).toBe(201);
    await expect(pending.json()).resolves.toMatchObject({
      data: [{
        id: registeredBody.data.id,
        destinationId: 'Upend…',
        displayName: '保留 太郎',
        source: 'manual',
        status: 'discovered',
        contactId: null,
      }],
    });

    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/line-destinations/${registeredBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(removed.status).toBe(200);
    await expect(afterRemoval.json()).resolves.toMatchObject({ data: [] });
  });

  it('promotes a pending LINE contact to a full Contact and blocks removing a linked one', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const registered = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upromote0000000000000000000000000' },
      'POST',
    ), fixture.environment);
    const registeredBody = await registered.json() as { data: { id: string } };

    const promoted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '昇格 花子', lineDestinationId: registeredBody.data.id },
    ), fixture.environment);
    const blockedRemoval = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/line-destinations/${registeredBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const duplicateRegistration = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upromote0000000000000000000000000' },
      'POST',
    ), fixture.environment);

    expect(promoted.status).toBe(201);
    expect(blockedRemoval.status).toBe(409);
    expect(duplicateRegistration.status).toBe(409);
  });
});

describe('AI Task reassignment', () => {
  const seedOpenTask = (account: TestApp['account'], input: { id: string; title: string; roleId: string; roleName: string }): void => {
    account.execute(
      `INSERT OR IGNORE INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '総会案内', '2026-08-02T00:00:00.000Z', 'processing')`,
    );
    account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_role_id, assignee_role_name, assignee_member_id, assignee_name, description, remarks, completed, created_at, updated_at)
       VALUES (?, 'organization-1', 'source-1', '総会案内', ?, '2026-08-25', ?, ?, NULL, '未割り当て', '指定口座へ送金する', '', 0, '2026-08-02', '2026-08-02')`,
      input.id,
      input.title,
      input.roleId,
      input.roleName,
    );
  };

  it('opens the reassignment review only after an Operational Task Role changes', async () => {
    fixture = createTestApp();
    const before = await app.fetch(fixture.request('/api/organizations/organization-1/task-reassignments'), fixture.environment);

    await expect(before.json()).resolves.toMatchObject({ data: { pending: false, rolesChangedAt: null } });

    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '会計担当', description: '支払期限を扱う',
    }), fixture.environment);
    const after = await app.fetch(fixture.request('/api/organizations/organization-1/task-reassignments'), fixture.environment);

    await expect(after.json()).resolves.toMatchObject({ data: { pending: true, rolesChangedAt: expect.any(String) } });
  });

  it('proposes a role for every open Task without writing one, then applies only what an Account accepted', async () => {
    const automation = await createAutomationTestApp({ ai: true });
    fixture = automation;
    const role = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '会計担当', description: '支払期限を扱う',
    }), fixture.environment);
    const roleId = (await role.json() as { data: { id: string } }).data.id;
    const contact = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/members', {
      name: '山田花子', email: 'hanako@example.com',
    }), fixture.environment);
    const contactId = (await contact.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/task-roles/${roleId}/assignment`,
      { contactId },
      'PUT',
    ), fixture.environment);
    seedOpenTask(automation.account, { id: 'task-1', title: '参加費を支払う', roleId: 'unassigned', roleName: '未割り当て' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ assignments: [{ taskId: 'task-1', assigneeRoleId: roleId, reason: '送金の期限だから' }] }) } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const suggested = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments/suggestions', {},
    ), fixture.environment);
    const unchanged = await app.fetch(fixture.request('/api/organizations/organization-1/tasks'), fixture.environment);

    expect(suggested.status).toBe(200);
    await expect(suggested.json()).resolves.toMatchObject({
      data: { proposals: [{ taskId: 'task-1', proposedRoleId: roleId, proposedRoleName: '会計担当', changed: true, reason: '送金の期限だから' }] },
    });
    await expect(unchanged.json()).resolves.toMatchObject({ data: [{ id: 'task-1', assigneeRoleId: 'unassigned' }] });

    const applied = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments',
      { assignments: [{ taskId: 'task-1', roleId }] },
    ), fixture.environment);

    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      data: {
        tasks: [{ id: 'task-1', assigneeRoleId: roleId, assigneeRoleName: '会計担当', assigneeContactId: contactId, assigneeName: '山田花子' }],
        skipped: [],
        review: { pending: false },
      },
    });
  });

  it('closes the review when an Account accepts none of the proposals', async () => {
    fixture = createTestApp();
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '会計担当', description: '支払期限を扱う',
    }), fixture.environment);

    const applied = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments', { assignments: [] },
    ), fixture.environment);

    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({ data: { tasks: [], review: { pending: false } } });
  });

  it('asks for an AI connection before proposing anything, and never asks the AI without an open Task', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '総会案内', '2026-08-02T00:00:00.000Z', 'processing')`,
    );
    const empty = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments/suggestions', {},
    ), fixture.environment);
    seedOpenTask(fixture.account, { id: 'task-1', title: '参加費を支払う', roleId: 'unassigned', roleName: '未割り当て' });
    const withoutAi = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments/suggestions', {},
    ), fixture.environment);

    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ data: { proposals: [] } });
    expect(withoutAi.status).toBe(409);
  });

  it('refuses an assignment batch that does not name a Task and a role', async () => {
    fixture = createTestApp();

    const response = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-reassignments',
      { assignments: [{ taskId: 'task-1' }] },
    ), fixture.environment);

    expect(response.status).toBe(400);
  });
});
