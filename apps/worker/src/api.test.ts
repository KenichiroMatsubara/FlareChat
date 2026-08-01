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
  seedOrganizationMember,
  seedScheduledEvent,
} from '../test/seed';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

describe('Organization access', () => {
  it('returns Automation Inbox behavior from the selected Organization', async () => {
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

  it('never falls back to another database when an Organization binding is unavailable', async () => {
    fixture = createTestApp();
    delete (fixture.environment as unknown as Record<string, unknown>).ORG_ORGANIZATION1;

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/connections'),
      fixture.environment,
    );

    expect(response.status).toBe(503);
  });

  it('keeps management data isolated between two Organizations', async () => {
    fixture = createTestApp('admin');
    fixture.addOrganization({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2', role: 'admin' });
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-2/lists',
      { kind: 'source', name: 'Organization Two Sources' },
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
      data: [{ name: 'Organization Two Sources' }],
    });
  });

  it('lets a Viewer inspect outcomes but rejects management changes', async () => {
    fixture = createTestApp('viewer');

    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    const listChange = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/lists',
      { kind: 'source', name: 'Forbidden' },
    ), fixture.environment);
    const recipientChange = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: 'Forbidden', email: 'forbidden@example.com' },
    ), fixture.environment);

    expect(dashboard.status).toBe(200);
    expect(listChange.status).toBe(403);
    expect(recipientChange.status).toBe(403);
  });
});

describe('OpenAI-compatible connection', () => {
  it('stores an arbitrary HTTPS Base URL and model and uses them for the connection test', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections',
      {
        line: {},
        ai: {
          baseUrl: 'https://gateway.example.com/openai/v1/',
          model: 'organization-model',
          apiKey: 'organization-api-key',
        },
      },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        ai: {
          apiKeyConfigured: true,
          baseUrl: 'https://gateway.example.com/openai/v1',
          model: 'organization-model',
        },
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
      '/api/organizations/organization-1/connections',
      {
        line: {},
        ai: {
          baseUrl: 'http://ai.example.com/v1',
          model: 'organization-model',
          apiKey: 'organization-api-key',
        },
      },
      'PUT',
    ), fixture.environment);

    expect(response.status).toBe(400);
  });
});

describe('Organization management', () => {
  it('creates and reads canonical Typed Lists and List Items', async () => {
    fixture = createTestApp('admin');
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/lists',
      { kind: 'source', name: 'Members', description: 'Verified senders' },
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
      data: [{ kind: 'source', name: 'Members' }],
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

  it('creates a Rule and exposes its lifecycle changes through the same interface', async () => {
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
    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/rules/${body.data.id}`,
      { state: 'active' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/rules'),
      fixture.environment,
    );

    expect([created.status, updated.status]).toEqual([201, 200]);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{
        id: body.data.id,
        name: 'Announcements',
        state: 'active',
        selectionPolicy: { source: 'trusted' },
      }],
    });
  });

  it('creates, changes, imports, reads, and snapshots Recipient Profiles', async () => {
    fixture = createTestApp('operator');
    seedScheduledEvent(fixture.organization, { id: 'event-1' });
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const body = await created.json() as { data: { id: string } };
    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${body.data.id}`,
      { tags: ['vip'], state: 'active' },
      'PATCH',
    ), fixture.environment);
    const imported = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients/import',
      { csv: 'name,email\nSecond,second@example.com\nInvalid,not-an-email' },
    ), fixture.environment);
    const snapshotted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1/recipient-snapshots',
      { recipientProfileIds: [body.data.id] },
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/recipients'),
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

  it('builds dashboard counts from durable Organization behavior', async () => {
    fixture = createTestApp();
    seedAutomationRule(fixture.organization, { id: 'rule-1' });
    seedScheduledEvent(fixture.organization, { id: 'event-1' });
    seedAutomationException(fixture.organization, { id: 'exception-1' });
    await enqueueJob(fixture.organization.binding, {
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
  it('makes an Owner membership suspension visible to the affected member', async () => {
    fixture = createTestApp();
    seedOrganizationMember(fixture.control, {
      identityId: 'identity-2',
      email: 'member@example.com',
      role: 'viewer',
      sessionId: 'session-2',
    });

    const changed = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members/identity-2',
      { role: 'operator', state: 'suspended' },
      'PATCH',
    ), fixture.environment);
    const memberView = await app.fetch(new Request('https://app.example.com/api/auth/me', {
      headers: { Cookie: 'mail_session=session-2' },
    }), fixture.environment);

    expect(changed.status).toBe(200);
    await expect(memberView.json()).resolves.toMatchObject({ data: { organizations: [] } });
  });

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
      data: { organizationId: 'organization-1', idempotencyKey: 'receipt-1', state: 'requested' },
    });
    expect(duplicate.status).toBe(409);
  });
});

describe('Public attendance and operational outcomes', () => {
  it('returns and changes only a live Event-scoped attendance token', async () => {
    fixture = createTestApp('operator');
    seedScheduledEvent(fixture.organization, {
      id: 'event-1',
      attendanceDeadline: '2099-01-01T00:00:00.000Z',
    });
    seedAttendanceRegistration(fixture.organization, {
      eventId: 'event-1',
      recipientId: 'item-1',
      destination: 'guest@example.com',
    });
    const path = '/api/public/organizations/organization-1/attendance/token-event-1-item-1';

    const initial = await app.fetch(new Request(`https://app.example.com${path}`), fixture.environment);
    const updated = await app.fetch(new Request(`https://app.example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'event-1', status: 'attending', comment: '参加します' }),
    }), fixture.environment);
    const current = await app.fetch(new Request(`https://app.example.com${path}`), fixture.environment);

    expect([initial.status, updated.status, current.status]).toEqual([200, 200, 200]);
    await expect(current.json()).resolves.toMatchObject({
      data: { eventId: 'event-1', status: 'attending', comment: '参加します' },
    });
  });

  it('rejects revoked attendance tokens', async () => {
    fixture = createTestApp('operator');
    seedScheduledEvent(fixture.organization, {
      id: 'event-1',
      attendanceDeadline: '2099-01-01T00:00:00.000Z',
    });
    seedAttendanceRegistration(fixture.organization, {
      eventId: 'event-1',
      recipientId: 'item-1',
      destination: 'guest@example.com',
      revokedAt: '2026-07-25T00:00:00.000Z',
    });

    const response = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/attendance/token-event-1-item-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', status: 'attending' }),
      },
    ), fixture.environment);

    expect(response.status).toBe(410);
  });

  it('exposes Event changes, Delivery Records, and Exception transitions through operations interfaces', async () => {
    fixture = createTestApp('operator');
    seedScheduledEvent(fixture.organization, { id: 'event-1', status: 'draft' });
    seedDeliveryRecord(fixture.organization, {
      id: 'delivery-1',
      eventId: 'event-1',
      destination: 'guest@example.com',
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    seedAutomationException(fixture.organization, { id: 'exception-1' });

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
    await expect(audit.json()).resolves.toMatchObject({
      data: [{ destination: 'guest@example.com', outcome: 'succeeded' }],
    });
    await expect(operations.json()).resolves.toMatchObject({
      data: [{ id: 'exception-1', state: 'resolved' }],
    });
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 1, exceptions: 0 },
    });
  });
});

describe('LINE destinations', () => {
  it('captures a LINE display name and assigns the discovered ID to a Recipient Profile', async () => {
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

    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment);
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{ id: string }> };
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      {
        name: '山田 太郎',
        email: 'taro@example.com',
        tags: ['ロータリー'],
        lineDestinationId: destinationsBody.data[0]?.id,
      },
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/recipients'),
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
          destinationId: 'U1234567890',
          displayName: '山田 太郎',
          kind: 'user',
        }],
      }],
    });
  });

  it('verifies a webhook, discovers a destination, and consumes its Recipient Link once', async () => {
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
    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment);
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };
    const issued = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-links`,
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
      data: { recipientProfileId: recipientBody.data.id, destinationId: 'group-1' },
    });
    expect(duplicate.status).toBe(410);
  });

  it('lets an Owner manually attach, correct, and unlink a LINE ID without a webhook event', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: '手動 太郎', email: 'manual@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const attached = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Umanualtypo0000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const attachedBody = await attached.json() as { data: { id: string } };

    const corrected = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Ucorrected0000000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/recipients'),
      fixture.environment,
    );

    expect(attached.status).toBe(201);
    expect(corrected.status).toBe(201);
    await expect(roster.json()).resolves.toMatchObject({
      data: [{
        id: recipientBody.data.id,
        lineDestinations: [{
          destinationId: 'Ucorrected0000000000000000000000',
          displayName: '手動 太郎',
          kind: 'user',
          source: 'manual',
        }],
      }],
    });

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-destination/${attachedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    expect(unlinked.status).toBe(404);

    const correctedBody = await corrected.json() as { data: { id: string } };
    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-destination/${correctedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/recipients'),
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
      '/api/organizations/organization-1/recipients',
      { name: 'Member One', email: 'one@example.com' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string } };
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: 'Member Two', email: 'two@example.com' },
    ), fixture.environment);
    const secondBody = await second.json() as { data: { id: string } };
    await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${firstBody.data.id}/line-destination`,
      { destinationId: 'Ushared00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    const conflict = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${secondBody.data.id}/line-destination`,
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
    await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment);
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{ id: string }> };
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recipients',
      { name: 'Discovered', email: 'discovered@example.com', lineDestinationId: destinationsBody.data[0]?.id },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/recipients/${recipientBody.data.id}/line-destination/${destinationsBody.data[0]?.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const stillDiscovered = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(unlinked.status).toBe(200);
    await expect(stillDiscovered.json()).resolves.toMatchObject({
      data: [{ id: destinationsBody.data[0]?.id, recipientProfileId: null, source: 'webhook' }],
    });
  });
});
