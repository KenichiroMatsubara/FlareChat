import { describe, expect, it } from 'vitest';

import { app, DEFAULT_GEMINI_MODEL, generatedText } from './api';

const ownerSetup = {
  id: 'setup-1',
  name: 'Example Organization',
  state: 'awaiting_passkey' as const,
  oauth_state_hash: 'oauth-state',
  pkce_verifier_envelope: '{}',
  passkey_challenge_hash: null,
  inbox_address: 'automation@example.com',
  google_subject: 'google-subject',
  granted_scopes: '[]',
  credential_envelope: '{}',
  history_id: '1',
  owner_email: null,
  owner_identity_id: null,
  organization_id: null,
  database_id: null,
  binding_name: null,
  provisioning_key: null,
  error_message: null,
  expires_at: '2099-01-01T00:00:00.000Z',
  provisioning_expires_at: null,
  created_at: '2026-07-25T00:00:00.000Z',
  updated_at: '2026-07-25T00:00:00.000Z',
};

const setupDatabase = () => ({
  prepare: (sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: async () => sql.includes('FROM organization_setups') ? ownerSetup : null,
      run: async () => ({ meta: { changes: 1 } }),
    }),
  }),
}) as unknown as D1Database;

const setupEnvironment = () => ({
  CONTROL_DB: setupDatabase(),
  ASSETS: {} as Fetcher,
  APP_URL: 'https://app.example.com',
  WEB_ORIGIN: 'https://app.example.com',
  RP_ID: 'app.example.com',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  CREDENTIAL_MASTER_KEY: '',
  CREDENTIAL_MASTER_KEY_VERSION: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_WORKER_NAME: '',
  ACTIVE_ORGANIZATION_LIMIT: '10',
});

describe('Gemini test response', () => {
  it('uses the current Flash Lite model without requiring user model input', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
  });

  it('joins text parts while ignoring non-text parts', () => {
    expect(generatedText({
      candidates: [{ content: { parts: [{ text: '東京' }, {}, { text: 'です。' }] } }],
    })).toBe('東京です。');
  });

  it('returns an empty string when Gemini has no textual candidate', () => {
    expect(generatedText({ candidates: [{ content: { parts: [{}] } }] })).toBe('');
  });
});

describe('Organization setup', () => {
  it('registers the initial Owner as a distinct management Identity', async () => {
    const response = await app.fetch(new Request('https://app.example.com/api/setup/passkey/options', {
      method: 'POST',
      headers: { Cookie: 'mail_setup=setup-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerEmail: 'owner@example.com' }),
    }), setupEnvironment());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { user: { name: 'owner@example.com', displayName: 'owner@example.com' } },
    });
  });
});

describe('Organization lists', () => {
  it('returns Typed Lists only from the signed-in member\'s Organization database', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'owner@example.com', display_name: 'Owner' };
            if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
            return null;
          },
        }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (_sql: string) => ({ all: async () => ({ results: [{ id: 'list-1', kind: 'source', name: 'Members', description: '', created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z' }] }) }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/lists', {
      headers: { Cookie: 'mail_session=session-1' },
    }), {
      ...setupEnvironment(),
      CONTROL_DB: controlDatabase,
      ORG_ORGANIZATION1: organizationDatabase,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: 'list-1', kind: 'source', name: 'Members' }] });
  });

  it('allows an Owner to create a Typed List in that Organization database', async () => {
    const inserted: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'owner@example.com', display_name: 'Owner' };
            if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
            return null;
          },
        }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (_sql: string) => ({
        bind: (...values: unknown[]) => ({ run: async () => { inserted.push(values); return { meta: { changes: 1 } }; } }),
      }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/lists', {
      method: 'POST',
      headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'source', name: 'Members', description: 'Verified senders' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { organizationId: 'organization-1', kind: 'source', name: 'Members' } });
    expect(inserted[0]).toContain('organization-1');
  });

  it('allows an Admin to add and later disable a List Item without exposing another Organization', async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'admin@example.com', display_name: 'Admin' };
            if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'admin' };
            return null;
          },
        }),
      }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({ run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } }),
      }),
    } as unknown as D1Database;
    const environment = { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase };
    const created = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/lists/list-1/items', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'member@example.com', label: 'Member' }),
    }), environment);
    const disabled = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/lists/list-1/items/item-1', {
      method: 'PATCH', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }), environment);

    expect(created.status).toBe(201);
    expect(disabled.status).toBe(200);
    expect(writes.some((write) => write.sql.includes('INSERT INTO list_items'))).toBe(true);
    expect(writes.some((write) => write.sql.includes('UPDATE list_items SET enabled'))).toBe(true);
  });
});

describe('Automation Rules', () => {
  it('creates an Organization-scoped Draft Rule for an Owner', async () => {
    const writes: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'owner@example.com', display_name: 'Owner' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (_sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => { writes.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/rules', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Announcements', state: 'draft' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { organizationId: 'organization-1', name: 'Announcements', state: 'draft' } });
    expect(writes[0]).toContain('organization-1');
  });

  it('moves a Rule through its explicit lifecycle states', async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'owner@example.com', display_name: 'Owner' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/rules/rule-1', {
      method: 'PATCH', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'active' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    expect(writes[0]).toMatchObject({ sql: expect.stringContaining('UPDATE rules SET status'), values: ['active', expect.any(String), 'rule-1'] });
  });
});
