import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { randomToken } from './encoding';
import { GOOGLE_IDENTITY_SCOPES, GOOGLE_SCOPES } from './google';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { createTestD1Database, type TestD1Database } from '../test/d1';

let fixture: TestApp | undefined;
let localAccount: TestD1Database | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localAccount?.close();
  localAccount = undefined;
  fixture?.close();
  fixture = undefined;
});

describe('application entry', () => {
  it('reports the checked Control schema version from health instead of a database-blind ok', async () => {
    fixture = createTestApp({ controlMigration: '0000_initial.sql' });

    const health = await app.fetch(fixture.request('/api/health'), fixture.environment);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      data: {
        status: 'ok',
        database: {
          control: {
            currentMigration: '0005_member_logins.sql',
            expectedMigration: '0005_member_logins.sql',
          },
        },
      },
    });
  });

  it('makes each database ready before an existing Account bootstrap uses its schema', async () => {
    fixture = createTestApp({
      controlMigration: '0000_initial.sql',
      accountMigration: '0013_agent_rule_writes.sql',
    });
    const secondAccount = fixture.addAccount({
      id: 'organization-2',
      bindingName: 'ORG_ORGANIZATION2',
      migration: '0000_initial.sql',
    });

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        accounts: [
          { accountId: 'organization-1' },
          { accountId: 'organization-2' },
        ],
      },
    });
    expect(fixture.control.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '0005_member_logins.sql' }]);
    expect(fixture.account.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '0030_one_reminder_kind.sql' }]);
    expect(secondAccount.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '0030_one_reminder_kind.sql' }]);
  });

  it('reports the exact Account schema mismatch without revoking the session', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      'INSERT INTO d1_migrations (name) VALUES (?)',
      '9999_future.sql',
    );

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap', {
      headers: { Origin: 'http://localhost:5173' },
    }), fixture.environment);

    expect(bootstrap.status).toBe(503);
    expect(bootstrap.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    await expect(bootstrap.json()).resolves.toMatchObject({
      error: {
        code: 'schema_not_ready',
        category: 'database_ahead',
        databaseKind: 'organization',
        databaseId: 'database-1',
        bindingName: 'ORG_ORGANIZATION1',
        currentMigration: '9999_future.sql',
        expectedMigration: '0030_one_reminder_kind.sql',
        requestId: expect.any(String),
      },
    });
    expect(fixture.control.rows<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM sessions WHERE id = 'session-1'",
    )).toEqual([{ revoked_at: null }]);
  });

  it('reports a Control schema mismatch before login code can hide it', async () => {
    fixture = createTestApp();
    fixture.control.execute(
      'INSERT INTO d1_migrations (name) VALUES (?)',
      '9999_future.sql',
    );

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap', {
      headers: { Origin: 'http://localhost:5173' },
    }), fixture.environment);

    expect(bootstrap.status).toBe(503);
    expect(bootstrap.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    await expect(bootstrap.json()).resolves.toMatchObject({
      error: {
        code: 'schema_not_ready',
        category: 'database_ahead',
        databaseKind: 'control',
        databaseId: null,
        bindingName: 'CONTROL_DB',
        currentMigration: '9999_future.sql',
        expectedMigration: '0005_member_logins.sql',
        requestId: expect.any(String),
      },
    });
    expect(fixture.control.rows<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM sessions WHERE id = 'session-1'",
    )).toEqual([{ revoked_at: null }]);
  });

  it('returns an existing Account to their Account after identity-only Google login', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'identity-access',
          refresh_token: 'identity-refresh',
          expires_in: 3_600,
          scope: GOOGLE_IDENTITY_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Owner',
        }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'login' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_IDENTITY_SCOPES.join(' '));
    expect(callback.headers.get('set-cookie')).not.toContain('mail_setup=');
    await expect(bootstrap.json()).resolves.toEqual({
      data: {
        kind: 'ready',
        identity: { email: 'owner@example.com', displayName: 'Owner' },
        accounts: [{
          accountId: 'organization-1',
          name: 'Account One',
          status: 'active',
        }],
      },
    });
  });

  it('keeps the Owner session and Membership when the Automation Inbox is disconnected', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET status = 'disconnected', enabled = 0 WHERE kind = 'automation_inbox'",
    );

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    const identity = await app.fetch(fixture.request('/api/auth/me'), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        accounts: [{ accountId: 'organization-1' }],
      },
    });
    await expect(identity.json()).resolves.toMatchObject({
      data: {
        email: 'owner@example.com',
        accounts: [{ accountId: 'organization-1' }],
      },
    });
  });

  it('checks an expired Automation Inbox token at login and records a required reauthentication', async () => {
    fixture = await createAutomationTestApp();
    const keyRecord = fixture.control.row<{ master_key_version: string; wrapped_key_envelope: string }>(
      "SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = 'organization-1'",
    );
    const accountKey = await unwrapAccountKey({
      masterKeyVersion: keyRecord?.master_key_version ?? '',
      envelope: JSON.parse(keyRecord?.wrapped_key_envelope ?? '{}'),
    }, await masterKey(fixture.environment.CREDENTIAL_MASTER_KEY), 'organization-1');
    const expiredToken = await encrypt(JSON.stringify({
      accessToken: 'expired-access',
      refreshToken: 'expired-refresh',
      expiresAt: '2000-01-01T00:00:00.000Z',
      scopes: GOOGLE_SCOPES,
      tokenType: 'Bearer',
    }), accountKey, 'google-connection:organization-1:automation-inbox');
    fixture.account.execute(
      "UPDATE google_connections SET token_envelope = ? WHERE id = 'inbox-1'",
      JSON.stringify(expiredToken),
    );
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);

    expect(bootstrap.status).toBe(200);
    expect(fixture.account.row<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM google_connections WHERE id = 'inbox-1'",
    )).toEqual({ status: 'reauthentication_required', last_error: 'Token has been expired or revoked.' });
  });

  it('reconnects a reauthentication-required Automation Inbox and keeps its Gmail cursor so the outage is processed', async () => {
    fixture = await createAutomationTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET google_subject = 'google-subject-1', status = 'reauthentication_required', last_error = 'Token has been expired or revoked.' WHERE id = 'inbox-1'",
    );
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'reconnected-access',
          refresh_token: 'reconnected-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-after-reconnect' }));
      }
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(fixture.request('/api/organizations/organization-1/automation/reauthorize', {
      method: 'POST',
    }), fixture.environment);

    expect(started.status).toBe(201);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));

    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');

    expect(redirect.pathname).toBe('/organizations/organization-1/automation');
    expect(callback.headers.get('set-cookie')).toContain('mail_session=');
    expect(fixture.account.rows<{ status: string; last_error: string | null; gmail_history_id: string }>(
      "SELECT status, last_error, gmail_history_id FROM google_connections WHERE id = 'inbox-1'",
    )).toEqual([{
      status: 'active',
      last_error: null,
      gmail_history_id: 'history-before-connection',
    }]);
  });

  it('opens Account setup from one complete Google grant without a setup cookie', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-new',
          email: 'new-owner@example.com',
          name: 'New Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-new' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));
    expect(callback.headers.get('set-cookie')).not.toContain('mail_setup=');
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'confirming_organization',
        identity: { email: 'new-owner@example.com', displayName: 'New Owner' },
        setup: {
          name: 'New Owner',
          inboxAddress: 'new-owner@example.com',
        },
      },
    });
  });

  it('treats Account setup by an existing Account as ordinary login', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-existing' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const redirect = new URL(callback.headers.get('location') ?? 'https://app.example.com');
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(redirect.pathname).toBe('/');
    expect(redirect.searchParams.get('error')).toBeNull();
    expect(callback.headers.get('set-cookie')).toContain('mail_session=');
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        accounts: [{ accountId: 'organization-1' }],
      },
    });
    expect(fixture.control.row<{ count: number }>('SELECT COUNT(*) AS count FROM organizations')?.count).toBe(1);
    expect(fixture.control.row<{ count: number }>('SELECT COUNT(*) AS count FROM organization_setups')?.count).toBe(0);
    expect(fixture.control.row<{ count: number }>('SELECT COUNT(*) AS count FROM organization_provisionings')?.count).toBe(0);
  });

  it('confirms the Account name and selected Preset through the session', async () => {
    fixture = createTestApp();
    localAccount = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localAccount.binding;
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-new',
          email: 'new-owner@example.com',
          name: 'New Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-new' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const confirmed = await app.fetch(new Request('https://app.example.com/api/onboarding/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `mail_session=${sessionCookie}`,
      },
      body: JSON.stringify({ name: 'New Account', presetId: 'membership-organization' }),
    }), fixture.environment);
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toEqual({ data: { accepted: true } });
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        identity: { email: 'new-owner@example.com' },
        accounts: [{
          name: 'New Account',
          status: 'active',
        }],
      },
    });
    expect(localAccount.rows<{ name: string }>('SELECT name FROM lists ORDER BY name')).toEqual([
      { name: 'Calendar members' },
      { name: 'LINE members' },
      { name: 'Trusted announcement sources' },
    ]);
  });

  it('returns an unassigned identity after an unconfirmed Account setup expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-expiring',
          email: 'expiring-owner@example.com',
          name: 'Expiring Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-expiring' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];

    vi.advanceTimersByTime(16 * 60 * 1_000);
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'unassigned',
        identity: { email: 'expiring-owner@example.com' },
      },
    });
  });

  it('keeps a failed Account provisioning visible and retries it through the session', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-retry',
          email: 'retry-owner@example.com',
          name: 'Retry Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-retry' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unavailable external dependency: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), fixture.environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), fixture.environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    await app.fetch(new Request('https://app.example.com/api/onboarding/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `mail_session=${sessionCookie}`,
      },
      body: JSON.stringify({ name: 'Retry Account' }),
    }), fixture.environment);
    const failed = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    await expect(failed.json()).resolves.toMatchObject({
      data: {
        kind: 'provisioning_failed',
        account: { name: 'Retry Account' },
        phase: 'allocating_database',
        error: 'Cloudflare D1 credentials are not configured.',
      },
    });

    localAccount = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localAccount.binding;
    const retried = await app.fetch(new Request('https://app.example.com/api/onboarding/retry', {
      method: 'POST',
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);
    const ready = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    expect(retried.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        accounts: [{ name: 'Retry Account', status: 'active' }],
      },
    });
  });

  it('cancels an unconfirmed setup and allows the same Automation Inbox to start again', async () => {
    fixture = createTestApp();
    fixture.environment.CREDENTIAL_MASTER_KEY = randomToken(32);
    fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'test-v1';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'setup-access',
          refresh_token: 'setup-refresh',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-cancelled',
          email: 'cancelled-owner@example.com',
          name: 'Cancelled Owner',
        }));
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-cancelled' }));
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke?')) return new Response(null);
      throw new Error(`Unexpected Google request: ${url}`);
    }));
    const begin = async (): Promise<{ callback: Response; authorization: URL }> => {
      const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'organization_setup' }),
      }), fixture?.environment);
      const startedBody = await started.json() as { data: { authorizationUrl: string } };
      const authorization = new URL(startedBody.data.authorizationUrl);
      const callback = await app.fetch(new Request(
        `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
      ), fixture?.environment);
      return { callback, authorization };
    };

    const first = await begin();
    const firstSession = first.callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const cancelled = await app.fetch(new Request('https://app.example.com/api/onboarding', {
      method: 'DELETE',
      headers: { Cookie: `mail_session=${firstSession}` },
    }), fixture.environment);
    const unassigned = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${firstSession}` },
    }), fixture.environment);
    const second = await begin();
    const secondRedirect = new URL(second.callback.headers.get('location') ?? 'https://app.example.com');

    expect(cancelled.status).toBe(200);
    await expect(unassigned.json()).resolves.toMatchObject({ data: { kind: 'unassigned' } });
    expect(secondRedirect.searchParams.get('error')).toBeNull();
    expect(second.callback.headers.get('set-cookie')).toContain('mail_session=');
  });
});
