import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelCredentials, contactChannels, reachableContacts, sendOnChannel } from './channel';
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
      text: 'こんにちは',
    });

    expect(delivery).toEqual({
      delivered: true,
      channel: 'line',
      contactId: 'contact-1',
      destination: 'U-one',
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
      text: 'こんにちは',
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
      text: 'こんにちは',
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
