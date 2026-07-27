import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { randomToken } from './encoding';
import { GOOGLE_IDENTITY_SCOPES, GOOGLE_SCOPES } from './google';
import { createTestApp, type TestApp } from '../test/app';
import { createTestD1Database, type TestD1Database } from '../test/d1';

let fixture: TestApp | undefined;
let localOrganization: TestD1Database | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localOrganization?.close();
  localOrganization = undefined;
  fixture?.close();
  fixture = undefined;
});

describe('application entry', () => {
  it.each(['owner', 'admin', 'operator', 'viewer'] as const)(
    'returns an existing %s to their Organization after identity-only Google login',
    async (role) => {
    fixture = createTestApp(role);
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
        organizations: [{
          organizationId: 'organization-1',
          role,
          name: 'Organization One',
          status: 'active',
        }],
      },
    });
  });

  it('keeps the Owner session and Membership when the Automation Inbox is disconnected', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      "UPDATE google_connections SET status = 'disconnected', enabled = 0 WHERE kind = 'automation_inbox'",
    );

    const bootstrap = await app.fetch(fixture.request('/api/bootstrap'), fixture.environment);
    const identity = await app.fetch(fixture.request('/api/auth/me'), fixture.environment);

    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'ready',
        organizations: [{ organizationId: 'organization-1', role: 'owner' }],
      },
    });
    await expect(identity.json()).resolves.toMatchObject({
      data: {
        email: 'owner@example.com',
        organizations: [{ organizationId: 'organization-1', role: 'owner' }],
      },
    });
  });

  it('opens Organization setup from one complete Google grant without a setup cookie', async () => {
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

  it('rejects an Automation Inbox already claimed by an Organization even when its address differs from the Owner', async () => {
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
          email: 'inbox@example.com',
          name: 'Existing Inbox',
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

    expect(redirect.searchParams.get('error')).toBe('automation_inbox_already_claimed');
    expect(callback.headers.get('set-cookie') ?? '').not.toContain('mail_session=');
  });

  it('confirms the Organization name through the session and activates the provisioned Organization', async () => {
    fixture = createTestApp();
    localOrganization = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localOrganization.binding;
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
      body: JSON.stringify({ name: 'New Organization' }),
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
        organizations: [{
          name: 'New Organization',
          role: 'owner',
          status: 'active',
        }],
      },
    });
  });

  it('returns an unassigned identity after an unconfirmed Organization setup expires', async () => {
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

  it('keeps a failed Organization provisioning visible and retries it through the session', async () => {
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
      body: JSON.stringify({ name: 'Retry Organization' }),
    }), fixture.environment);
    const failed = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), fixture.environment);

    await expect(failed.json()).resolves.toMatchObject({
      data: {
        kind: 'provisioning_failed',
        organization: { name: 'Retry Organization' },
        phase: 'allocating_database',
        error: 'Cloudflare D1 credentials are not configured.',
      },
    });

    localOrganization = createTestD1Database();
    (fixture.environment as unknown as Record<string, unknown>).LOCAL_ORGANIZATION_DB_1 = localOrganization.binding;
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
        organizations: [{ name: 'Retry Organization', status: 'active' }],
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
