import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelCredentials, contactChannels, LINE_BATCH_LIMIT, reachableContacts, sendOnChannel, sendOnDestination, sendToDestinations } from './channel';
import { encrypt, masterKey } from './cryptography';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

const CREATED_AT = '2026-08-01T00:00:00.000Z';
const openDatabases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of openDatabases.splice(0)) database.close();
});

const channelDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  return database;
};

const seedContact = (database: TestD1Database, input: { id: string; name?: string }): void => {
  database.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES (?, 'organization-1', ?, ?, 'active', '[]', ?, ?)`,
    input.id,
    input.name ?? input.id,
    `${input.id}@example.com`,
    CREATED_AT,
    CREATED_AT,
  );
};

const seedLineHandle = (database: TestD1Database, input: { contactId: string; destination: string }): void => {
  database.execute(
    `INSERT OR IGNORE INTO connections (id, kind, label, credential, status, created_at, updated_at)
     VALUES ('line-connection', 'line', 'LINE', '{}', 'active', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  database.execute(
    `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
     VALUES (?, 'line-connection', ?, 'user', ?, 'discovered', 'manual', ?, ?)`,
    `dest-${input.contactId}`,
    input.destination,
    input.contactId,
    CREATED_AT,
    CREATED_AT,
  );
  database.execute(
    'INSERT INTO member_line_destinations (member_id, line_destination_id, created_at) VALUES (?, ?, ?)',
    input.contactId,
    `dest-${input.contactId}`,
    CREATED_AT,
  );
};

const seedDiscordHandle = (database: TestD1Database, input: { contactId: string; channelId: string }): void => {
  database.execute(
    `INSERT OR IGNORE INTO connections (id, kind, label, credential, status, created_at, updated_at)
     VALUES ('discord-connection', 'discord', 'Discord', '{}', 'active', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  database.execute(
    `INSERT INTO channel_handles
      (id, contact_id, channel, connection_id, external_id, reply_target, kind, display_name, source, is_primary, created_at, updated_at)
     VALUES (?, ?, 'discord', 'discord-connection', ?, ?, 'single', ?, 'inbound', 1, ?, ?)`,
    `handle-${input.contactId}`,
    input.contactId,
    `user-${input.contactId}`,
    input.channelId,
    input.contactId,
    CREATED_AT,
    CREATED_AT,
  );
};

describe('reaching a Contact on a Channel', () => {
  it('sends one LINE message and records the delivery it made', async () => {
    const database = channelDatabase();
    seedContact(database, { id: 'contact-1' });
    seedLineHandle(database, { contactId: 'contact-1', destination: 'U-one' });
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-1' } });
    });

    const delivery = await sendOnChannel({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      contactId: 'contact-1',
      channel: 'line',
      texts: ['こんにちは'],
    });

    expect(delivery).toEqual({
      delivered: true,
      channel: 'line',
      contactId: 'contact-1',
      destination: 'U-one',
      messages: 1,
      requests: 1,
      externalId: 'line-1',
    });
    expect(requests[0]?.body).toEqual({ to: 'U-one', messages: [{ type: 'text', text: 'こんにちは' }] });
    expect(database.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'line', outcome: 'succeeded' }]);
  });

  it('leaves a failed Delivery Record when Discord refuses', async () => {
    const database = channelDatabase();
    seedContact(database, { id: 'contact-1' });
    seedDiscordHandle(database, { contactId: 'contact-1', channelId: 'channel-9' });
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }));

    await expect(sendOnChannel({
      database: database.binding,
      credentials: { line: null, discord: 'bot-token' },
      contactId: 'contact-1',
      channel: 'discord',
      texts: ['こんにちは'],
    })).rejects.toThrow(/403/u);

    expect(database.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'discord', outcome: 'failed' }]);
  });

  it('refuses a Channel the product does not carry', async () => {
    const database = channelDatabase();
    seedContact(database, { id: 'contact-1' });

    await expect(sendOnChannel({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      contactId: 'contact-1',
      channel: 'sms',
      texts: ['こんにちは'],
    })).rejects.toThrow(/sms/u);
  });

  it('says where one Contact is reachable and where the roster is', async () => {
    const database = channelDatabase();
    seedContact(database, { id: 'contact-1', name: '一郎' });
    seedContact(database, { id: 'contact-2', name: '二郎' });
    seedLineHandle(database, { contactId: 'contact-1', destination: 'U-one' });
    seedDiscordHandle(database, { contactId: 'contact-1', channelId: 'channel-9' });

    expect(await contactChannels({ database: database.binding, contactId: 'contact-1' })).toEqual(['line', 'discord']);
    expect(await contactChannels({ database: database.binding, contactId: 'contact-2' })).toEqual([]);
    expect(await reachableContacts({ database: database.binding })).toEqual([
      { id: 'contact-1', name: '一郎', email: 'contact-1@example.com', state: 'active', channels: ['line', 'discord'] },
      { id: 'contact-2', name: '二郎', email: 'contact-2@example.com', state: 'active', channels: [] },
    ]);
  });

  it('reaches nobody when the bound Contact List is empty', async () => {
    const database = channelDatabase();
    seedContact(database, { id: 'contact-1' });

    expect(await reachableContacts({ database: database.binding, contactIds: [] })).toEqual([]);
  });

  it('reads both Channel credentials the Account stored', async () => {
    const database = channelDatabase();
    const accountKey = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    for (const [kind, credential] of [
      ['line', { channelAccessToken: 'line-token' }],
      ['discord', { botToken: 'bot-token' }],
    ] as const) {
      database.execute(
        `INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        `${kind}-connection`,
        kind,
        kind,
        JSON.stringify(await encrypt(JSON.stringify(credential), accountKey, `organization-connection:organization-1:${kind}`)),
        CREATED_AT,
        CREATED_AT,
      );
    }

    expect(await channelCredentials({ database: database.binding, accountKey, accountId: 'organization-1' }))
      .toEqual({ line: 'line-token', discord: 'bot-token' });
  });

  it('reports no credential when the Account connected nothing', async () => {
    const database = channelDatabase();
    const accountKey = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    expect(await channelCredentials({ database: database.binding, accountKey, accountId: 'organization-1' }))
      .toEqual({ line: null, discord: null });
  });
});

describe('batching what the provider lets us batch', () => {
  const pushes = (): { bodies: Array<{ to: string; messages: Array<{ text: string }> }> } => {
    const bodies: Array<{ to: string; messages: Array<{ text: string }> }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as { to: string; messages: Array<{ text: string }> });
      return new Response('{}', { status: 200, headers: { 'x-line-request-id': `line-${bodies.length}` } });
    });
    return { bodies };
  };

  it('carries five LINE messages to one destination in a single request', async () => {
    const database = channelDatabase();
    const { bodies } = pushes();

    const outcome = await sendOnDestination({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      channel: 'line',
      destination: 'U-one',
      texts: ['一', '二', '三', '四', '五'],
    });

    expect(LINE_BATCH_LIMIT).toBe(5);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.messages.map(({ text }) => text)).toEqual(['一', '二', '三', '四', '五']);
    expect(outcome).toMatchObject({ delivered: true, messages: 5, requests: 1 });
    expect(database.rows('SELECT outcome FROM deliveries')).toHaveLength(5);
  });

  it('splits a longer run into as few requests as the limit allows', async () => {
    const database = channelDatabase();
    const { bodies } = pushes();

    const outcome = await sendOnDestination({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      channel: 'line',
      destination: 'U-one',
      texts: ['一', '二', '三', '四', '五', '六', '七'],
    });

    expect(bodies.map((body) => body.messages.length)).toEqual([5, 2]);
    expect(outcome).toMatchObject({ delivered: true, messages: 7, requests: 2 });
    expect(database.rows('SELECT outcome FROM deliveries')).toHaveLength(7);
  });

  it('sends one message per request on Discord, which has no batch call', async () => {
    const database = channelDatabase();
    const bodies: Array<{ content: string }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as { content: string });
      return new Response(JSON.stringify({ id: `discord-${bodies.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const outcome = await sendOnDestination({
      database: database.binding,
      credentials: { line: null, discord: 'bot-token' },
      channel: 'discord',
      destination: 'channel-9',
      texts: ['一', '二'],
    });

    expect(bodies).toEqual([{ content: '一' }, { content: '二' }]);
    expect(outcome).toMatchObject({ delivered: true, messages: 2, requests: 2 });
  });

  it('reaches each address once, however often it was named', async () => {
    const database = channelDatabase();
    const { bodies } = pushes();

    const outcomes = await sendToDestinations({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      channel: 'line',
      destinations: ['U-one', 'C-group', 'U-one'],
      texts: ['お知らせ'],
    });

    expect(bodies.map((body) => body.to).sort()).toEqual(['C-group', 'U-one']);
    expect(outcomes).toHaveLength(2);
  });

  it('keeps a broadcast going when one address refuses, and says which did', async () => {
    const database = channelDatabase();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { to: string };
      return body.to === 'C-group'
        ? new Response('bad request', { status: 400 })
        : new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-1' } });
    });

    const outcomes = await sendToDestinations({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      channel: 'line',
      destinations: ['U-one', 'C-group'],
      texts: ['お知らせ'],
    });

    expect(outcomes.find((outcome) => outcome.destination === 'U-one')).toMatchObject({ delivered: true });
    expect(outcomes.find((outcome) => outcome.destination === 'C-group')).toMatchObject({ delivered: false, error: 'LINE refused the message.' });
    expect(database.rows('SELECT destination, outcome FROM deliveries ORDER BY destination'))
      .toEqual([{ destination: 'C-group', outcome: 'failed' }, { destination: 'U-one', outcome: 'succeeded' }]);
  });

  it('records the intended messages as failed when the Account has no Connection', async () => {
    const database = channelDatabase();

    const outcome = await sendOnDestination({
      database: database.binding,
      credentials: { line: null, discord: null },
      channel: 'line',
      destination: 'U-one',
      texts: ['一', '二'],
    });

    expect(outcome).toMatchObject({ delivered: false, messages: 2, requests: 0 });
    expect(database.rows('SELECT outcome FROM deliveries')).toEqual([{ outcome: 'failed' }, { outcome: 'failed' }]);
  });

  it('throws for a caller error rather than recording a delivery nobody asked for', async () => {
    const database = channelDatabase();

    await expect(sendOnDestination({
      database: database.binding,
      credentials: { line: 'line-token', discord: null },
      channel: 'line',
      destination: 'U-one',
      texts: ['   '],
    })).rejects.toThrow(/something to say/u);
    expect(database.rows('SELECT outcome FROM deliveries')).toEqual([]);
  });
});
