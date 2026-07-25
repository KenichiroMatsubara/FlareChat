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
  it('lists Rules and their explicit lifecycle state from the current Organization database', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'viewer-identity', email: 'viewer@example.com', display_name: 'Viewer' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'viewer' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (_sql: string) => ({ all: async () => ({ results: [{ id: 'rule-1', name: 'Announcements', status: 'active', selection_policy: '{}', routing_policy: '{}', priority: 0, created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z' }] }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/rules', { headers: { Cookie: 'mail_session=session-1' } }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: 'rule-1', state: 'active' }] });
  });

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

  it('snapshots Selection and Routing Policies as an immutable Rule Revision', async () => {
    const writes: string[] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'owner@example.com', display_name: 'Owner' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ run: async () => { writes.push(sql); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/rules', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Announcements', state: 'active', selectionPolicy: { sender: 'announcer@example.com' }, routingPolicy: { calendarRecipientListId: 'list-1' } }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(201);
    expect(writes).toContainEqual(expect.stringContaining('INSERT INTO rule_revisions'));
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

describe('Recipient Profiles', () => {
  it('lists Recipient Profiles from only the current Organization database', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'viewer-identity', email: 'viewer@example.com', display_name: 'Viewer' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'viewer' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (_sql: string) => ({ all: async () => ({ results: [{ id: 'recipient-1', name: 'Guest', email: 'guest@example.com', state: 'active', tags: '[]', created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z' }] }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/recipients', { headers: { Cookie: 'mail_session=session-1' } }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: 'recipient-1', email: '***' }] });
  });

  it('lets an Operator create a separate Recipient Profile in the Organization database', async () => {
    const writes: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'operator@example.com', display_name: 'Operator' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'operator' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/recipients', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Guest', email: 'guest@example.com' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { organizationId: 'organization-1', name: 'Guest', email: 'guest@example.com', state: 'active' } });
    expect(writes[0]).toContain('organization-1');
  });

  it('previews Recipient CSV imports without persisting malformed or duplicate rows', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'operator-identity', email: 'operator@example.com', display_name: 'Operator' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'operator' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/recipients/import/preview', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: 'Alice,alice@example.com\nAgain,ALICE@example.com\nBroken' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { accepted: [{ email: 'alice@example.com' }], duplicates: ['alice@example.com'], invalid: [{ row: 3 }] } });
  });

  it('imports only the accepted Recipient CSV rows into the current Organization database', async () => {
    const writes: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'operator-identity', email: 'operator@example.com', display_name: 'Operator' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'operator' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/recipients/import', {
      method: 'POST', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: 'Alice,alice@example.com\nAgain,ALICE@example.com\nBroken' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { imported: 1, duplicates: ['alice@example.com'], invalid: [{ row: 3 }] } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('organization-1');
    expect(writes[0]).toContain('alice@example.com');
  });

  it('lets an Operator update Recipient tags and deactivate a Profile in the current Organization', async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'operator-identity', email: 'operator@example.com', display_name: 'Operator' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'operator' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/recipients/recipient-1', {
      method: 'PATCH', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ['staff', 'priority'], state: 'inactive' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { id: 'recipient-1', state: 'inactive', tags: ['staff', 'priority'] } });
    expect(writes[0]).toMatchObject({ sql: expect.stringContaining('UPDATE recipient_profiles SET') });
    expect(writes[0]?.values).toContain('recipient-1');
  });
});

describe('Organization dashboard', () => {
  it('reports active Rules, upcoming events, pending Jobs, Exceptions, and the latest Inbox sync from one Organization database', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'identity-1', email: 'viewer@example.com', display_name: 'Viewer' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'viewer' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const dashboardResult = (sql: string) => {
      if (sql.includes('FROM rules')) return { count: 2 };
      if (sql.includes('FROM events')) return { count: 3 };
      if (sql.includes('FROM jobs')) return { count: 4 };
      if (sql.includes('FROM exceptions')) return { count: 5 };
      return { last_synced_at: '2026-07-25T00:00:00.000Z' };
    };
    const organizationDatabase = {
      prepare: (sql: string) => ({ first: async () => dashboardResult(sql), bind: (..._values: unknown[]) => ({ first: async () => dashboardResult(sql) }) }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/dashboard', { headers: { Cookie: 'mail_session=session-1' } }), {
      ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { activeRules: 2, upcomingEvents: 3, pendingJobs: 4, exceptions: 5, lastSyncedAt: '2026-07-25T00:00:00.000Z' } });
  });
});

describe('Organization membership', () => {
  it('lets an Owner change a member role without touching another Organization', async () => {
    const writes: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'owner-identity', email: 'owner@example.com', display_name: 'Owner' };
            if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'owner' };
            return null;
          },
          run: async () => { writes.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/members/member-identity', {
      method: 'PATCH', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'operator' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { identityId: 'member-identity', role: 'operator' } });
    expect(writes[0]).toContain('organization-1');
  });
});

describe('Public attendance', () => {
  it('records an attendance response only for a live, matching Event link', async () => {
    const writes: unknown[][] = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM organizations')) return { id: 'organization-1', status: 'active', binding_name: 'ORG_ORGANIZATION1' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => sql.includes('FROM attendance') ? { event_id: 'event-1', link_event_id: 'event-1', revoked_at: null, attendance_deadline: '2099-01-01T00:00:00.000Z' } : null,
          run: async () => { writes.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/public/organizations/organization-1/attendance/link-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: 'event-1', status: 'attending', comment: '参加します' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { eventId: 'event-1', status: 'attending' } });
    expect(writes[0]).toContain('attending');
    expect(writes[0]).toContain('参加します');
  });

  it('rejects an expired or revoked public attendance link without writing a response', async () => {
    const controlDatabase = {
      prepare: (_sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => ({ id: 'organization-1', status: 'active', binding_name: 'ORG_ORGANIZATION1' }) }) }),
    } as unknown as D1Database;
    let wrote = false;
    const organizationDatabase = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => sql.includes('FROM attendance') ? { event_id: 'event-1', link_event_id: 'event-1', revoked_at: '2026-07-24T00:00:00.000Z', attendance_deadline: '2099-01-01T00:00:00.000Z' } : null,
          run: async () => { wrote = true; return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/public/organizations/organization-1/attendance/revoked-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: 'event-1', status: 'not_attending' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(410);
    expect(wrote).toBe(false);
  });

  it('allows a live link to return an attendance response to unanswered', async () => {
    const controlDatabase = { prepare: (_sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => ({ id: 'organization-1', status: 'active', binding_name: 'ORG_ORGANIZATION1' }) }) }) } as unknown as D1Database;
    const organizationDatabase = { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => sql.includes('FROM attendance') ? { event_id: 'event-1', link_event_id: 'event-1', revoked_at: null, attendance_deadline: '2099-01-01T00:00:00.000Z' } : null, run: async () => ({ meta: { changes: 1 } }) }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/public/organizations/organization-1/attendance/link-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: 'event-1', status: 'unanswered' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { status: 'unanswered' } });
  });
});

describe('Manual Event overrides', () => {
  it('lets an Operator record a scoped manual Event change with an immutable audit entry', async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'operator-identity', email: 'operator@example.com', display_name: 'Operator' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'operator' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/events/event-1', {
      method: 'PATCH', headers: { Cookie: 'mail_session=session-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ startsAt: '2026-08-01T10:00:00+09:00', reason: '会場都合' }),
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { id: 'event-1', updatedFields: ['startsAt'] } });
    expect(writes.some((write) => write.sql.includes('UPDATE events SET starts_at'))).toBe(true);
    expect(writes.some((write) => write.sql.includes('INSERT INTO event_overrides'))).toBe(true);
    expect(writes.flatMap((write) => write.values)).toContain('operator-identity');
  });
});

describe('Organization delivery audit', () => {
  it('shows immutable delivery outcomes while masking destinations for a Viewer', async () => {
    const controlDatabase = {
      prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
        if (sql.includes('FROM sessions')) return { id: 'session-1', identity_id: 'viewer-identity', email: 'viewer@example.com', display_name: 'Viewer' };
        if (sql.includes('FROM members')) return { id: 'organization-1', name: 'Organization One', status: 'active', database_id: 'database-1', binding_name: 'ORG_ORGANIZATION1', role: 'viewer' };
        return null;
      } }) }),
    } as unknown as D1Database;
    const organizationDatabase = { prepare: (_sql: string) => ({ all: async () => ({ results: [{ id: 'delivery-1', event_id: 'event-1', channel: 'calendar', destination: 'guest@example.com', outcome: 'succeeded', external_id: 'google-event-1', created_at: '2026-07-25T00:00:00.000Z' }] }) }) } as unknown as D1Database;
    const response = await app.fetch(new Request('https://app.example.com/api/organizations/organization-1/audit/deliveries', {
      headers: { Cookie: 'mail_session=session-1' },
    }), { ...setupEnvironment(), CONTROL_DB: controlDatabase, ORG_ORGANIZATION1: organizationDatabase });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: 'delivery-1', eventId: 'event-1', destination: '***', outcome: 'succeeded' }] });
  });
});
