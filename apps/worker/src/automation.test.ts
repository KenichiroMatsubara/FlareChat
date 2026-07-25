import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractEventCandidate, selectActiveRule, runEnabledAutomations } from './automation';
import { createOrganizationKey, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';

afterEach(() => { vi.unstubAllGlobals(); });

describe('mail event extraction', () => {
  it('extracts a Japanese date and time range from a mail', () => {
    expect(extractEventCandidate('例会のお知らせ', '日時: 2026年8月3日 19:00〜21:30')).toEqual({
      title: '例会のお知らせ',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:30:00+09:00',
    });
  });

  it('does not invent an event when the mail omits a date or an end time', () => {
    expect(extractEventCandidate('お知らせ', '来週の19時から集まりましょう')).toBeNull();
    expect(extractEventCandidate('お知らせ', '2026/08/03 に集まりましょう')).toBeNull();
  });

  it('selects the highest-priority active Rule whose sender, domain, and keyword policy match', () => {
    expect(selectActiveRule([
      { id: 'rule-low', priority: 1, selectionPolicy: { domain: 'example.com' } },
      { id: 'rule-high', priority: 10, selectionPolicy: { sender: 'announcer@example.com', keyword: '例会' } },
    ], { sender: 'announcer@example.com', subject: '例会のお知らせ', body: '2026年8月3日 19:00〜21:00' })).toMatchObject({ id: 'rule-high' });
    expect(selectActiveRule([{ id: 'rule-1', priority: 1, selectionPolicy: { domain: 'example.com' } }], { sender: 'other@invalid.test', subject: '例会', body: '' })).toBeNull();
  });
});

describe('Organization Automation Inbox scheduling', () => {
  it('discovers Automation Inboxes from each active Organization database, not the retired Control database path', async () => {
    const controlQueries: string[] = [];
    const organizationQueries: string[] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        all: async () => {
          controlQueries.push(sql);
          return { results: [{ id: 'organization-1', binding_name: 'ORG_ORGANIZATION1', database_id: 'database-1' }] };
        },
        bind: (..._values: unknown[]) => ({
          all: async () => {
            controlQueries.push(sql);
            return { results: [{ id: 'organization-1', binding_name: 'ORG_ORGANIZATION1', database_id: 'database-1' }] };
          },
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        all: async () => { organizationQueries.push(sql); return { results: [] }; },
        bind: (..._values: unknown[]) => ({
          all: async () => { organizationQueries.push(sql); return { results: [] }; },
        }),
      }),
    } as unknown as D1Database;
    const env = {
      CONTROL_DB: controlDatabase,
      ORG_ORGANIZATION1: organizationDatabase,
    } as unknown as Parameters<typeof runEnabledAutomations>[0];

    await runEnabledAutomations(env);

    expect(controlQueries.join('\n')).toContain('FROM organizations');
    expect(controlQueries.join('\n')).not.toContain('google_automations');
    expect(organizationQueries.join('\n')).toContain('FROM google_connections');
  });

  it('reads only after the Inbox history boundary and persists the new boundary in that Organization database', async () => {
    const master = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const wrappedKey = await createOrganizationKey(master, 'v1', 'organization-1');
    const organizationKey = await unwrapOrganizationKey(wrappedKey, master, 'organization-1');
    const inbox = {
      id: 'inbox-1',
      kind: 'automation_inbox',
      google_subject: 'subject-1',
      inbox_address: 'automation@example.com',
      granted_scopes: '[]',
      token_envelope: JSON.stringify(await encrypt(JSON.stringify({
        accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: [], tokenType: 'Bearer',
      }), organizationKey, 'google-connection:organization-1:automation-inbox')),
      gmail_history_id: 'history-before-connection',
      status: 'active',
    };
    const updatedConnections: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM organizations') ? [{ id: 'organization-1', binding_name: 'ORG_ORGANIZATION1', database_id: 'database-1' }] : [] }),
        bind: (..._values: unknown[]) => ({
          first: async () => sql.includes('FROM organization_keys') ? { master_key_version: wrappedKey.masterKeyVersion, wrapped_key_envelope: JSON.stringify(wrappedKey.envelope) } : null,
        }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM google_connections') ? [inbox] : sql.includes('FROM rules') ? [{ id: 'rule-1', priority: 0, selection_policy: '{}' }] : [] }),
        bind: (...values: unknown[]) => ({
          run: async () => { updatedConnections.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ historyId: 'history-after-connection' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await runEnabledAutomations({
      CONTROL_DB: controlDatabase,
      ORG_ORGANIZATION1: organizationDatabase,
      CREDENTIAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      CREDENTIAL_MASTER_KEY_VERSION: 'v1',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    } as unknown as Parameters<typeof runEnabledAutomations>[0]);

    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('startHistoryId')).toBe('history-before-connection');
    expect(updatedConnections).toContainEqual(['history-after-connection', expect.any(String), 'inbox-1']);
  });

  it('creates one Scheduled Event in the owning Organization database for a newly discovered dated Source Message', async () => {
    const master = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const wrappedKey = await createOrganizationKey(master, 'v1', 'organization-1');
    const organizationKey = await unwrapOrganizationKey(wrappedKey, master, 'organization-1');
    const inbox = {
      id: 'inbox-1', kind: 'automation_inbox', google_subject: 'subject-1', inbox_address: 'automation@example.com', granted_scopes: '[]',
      token_envelope: JSON.stringify(await encrypt(JSON.stringify({ accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: [], tokenType: 'Bearer' }), organizationKey, 'google-connection:organization-1:automation-inbox')),
      gmail_history_id: 'history-before-connection', status: 'active',
    };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM organizations') ? [{ id: 'organization-1', binding_name: 'ORG_ORGANIZATION1', database_id: 'database-1' }] : [] }),
        bind: (..._values: unknown[]) => ({ first: async () => sql.includes('FROM organization_keys') ? { master_key_version: wrappedKey.masterKeyVersion, wrapped_key_envelope: JSON.stringify(wrappedKey.envelope) } : null }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM google_connections') ? [inbox] : sql.includes('FROM rules') ? [{ id: 'rule-1', priority: 0, selection_policy: '{}' }] : [] }),
        bind: (...values: unknown[]) => ({
          first: async () => null,
          run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/history')) return new Response(JSON.stringify({ historyId: 'history-after-connection', history: [{ messagesAdded: [{ message: { id: 'gmail-message-1' } }] }] }), { status: 200 });
      if (url.includes('/messages/gmail-message-1')) return new Response(JSON.stringify({ payload: { headers: [{ name: 'Subject', value: '例会のお知らせ' }, { name: 'From', value: 'member@example.com' }], body: { data: btoa(String.fromCharCode(...new TextEncoder().encode('日時: 2026年8月3日 19:00〜21:30'))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') } } }), { status: 200 });
      return new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await runEnabledAutomations({ CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase, CREDENTIAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', CREDENTIAL_MASTER_KEY_VERSION: 'v1', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' } as unknown as Parameters<typeof runEnabledAutomations>[0]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(writes.some((write) => write.sql.includes('INSERT INTO events'))).toBe(true);
    expect(writes.find((write) => write.sql.includes('INSERT INTO events'))?.values).toContain('organization-1');
  });

  it('creates an Exception instead of a Scheduled Event when configured Gemini output is unsafe', async () => {
    const master = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const wrappedKey = await createOrganizationKey(master, 'v1', 'organization-1');
    const organizationKey = await unwrapOrganizationKey(wrappedKey, master, 'organization-1');
    const inbox = {
      id: 'inbox-1', kind: 'automation_inbox', google_subject: 'subject-1', inbox_address: 'automation@example.com', granted_scopes: '[]',
      token_envelope: JSON.stringify(await encrypt(JSON.stringify({ accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: [], tokenType: 'Bearer' }), organizationKey, 'google-connection:organization-1:automation-inbox')),
      gmail_history_id: 'history-before-connection', status: 'active',
    };
    const aiConnection = { id: 'ai-1', kind: 'ai', label: 'Gemini', credential: JSON.stringify(await encrypt(JSON.stringify({ provider: 'Google Gemini API', apiKey: 'api-key', model: 'gemini-3.5-flash-lite' }), organizationKey, 'organization-connection:organization-1:ai')), status: 'active' };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM organizations') ? [{ id: 'organization-1', binding_name: 'ORG_ORGANIZATION1', database_id: 'database-1' }] : [] }),
        bind: (..._values: unknown[]) => ({ first: async () => sql.includes('FROM organization_keys') ? { master_key_version: wrappedKey.masterKeyVersion, wrapped_key_envelope: JSON.stringify(wrappedKey.envelope) } : null }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes('FROM google_connections') ? [inbox] : sql.includes('FROM rules') ? [{ id: 'rule-1', priority: 0, selection_policy: '{}' }] : [] }),
        bind: (...values: unknown[]) => ({
          first: async () => sql.includes('FROM source_messages') ? null : sql.includes('FROM connections') ? aiConnection : null,
          run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/history')) return new Response(JSON.stringify({ historyId: 'history-after-connection', history: [{ messagesAdded: [{ message: { id: 'gmail-message-1' } }] }] }), { status: 200 });
      if (url.includes('/messages/gmail-message-1')) return new Response(JSON.stringify({ payload: { headers: [{ name: 'Subject', value: '例会' }, { name: 'From', value: 'member@example.com' }], body: { data: btoa(String.fromCharCode(...new TextEncoder().encode('日時: 2026年8月3日 19:00〜21:30'))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') } } }), { status: 200 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"日時未定"}' }] } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await runEnabledAutomations({ CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase, CREDENTIAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', CREDENTIAL_MASTER_KEY_VERSION: 'v1', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' } as unknown as Parameters<typeof runEnabledAutomations>[0]);

    expect(writes.some((write) => write.sql.includes('INSERT INTO exceptions'))).toBe(true);
    expect(writes.some((write) => write.sql.includes('INSERT INTO events'))).toBe(false);
  });
});
