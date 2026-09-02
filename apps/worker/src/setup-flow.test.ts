import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { GOOGLE_SCOPES } from './google';
import { randomToken } from './encoding';
import type { Bindings } from './types';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

let control: TestD1Database | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  control?.close();
  control = undefined;
});

describe('single-authorization Account setup', () => {
  it('uses the granted Google identity as both Automation Inbox and initial Owner identity', async () => {
    control = createMigratedTestD1('control');
    const environment = {
      CONTROL_DB: control.binding,
      ASSETS: {} as Fetcher,
      APP_URL: 'https://app.example.com',
      WEB_ORIGIN: 'https://app.example.com',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      CREDENTIAL_MASTER_KEY: randomToken(32),
      CREDENTIAL_MASTER_KEY_VERSION: 'test-v1',
    } as unknown as Bindings;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3_600,
          scope: GOOGLE_SCOPES.join(' '),
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({
          sub: 'google-subject-1',
          email: 'owner@example.com',
          name: 'Example Owner',
        }), { status: 200 });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        return new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    }));

    const started = await app.fetch(new Request('https://app.example.com/api/entry/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'organization_setup' }),
    }), environment);
    const startedBody = await started.json() as { data: { authorizationUrl: string } };
    const authorization = new URL(startedBody.data.authorizationUrl);
    const callback = await app.fetch(new Request(
      `https://app.example.com/oauth/google/callback?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    ), environment);
    const sessionCookie = callback.headers.get('set-cookie')?.match(/mail_session=([^;]+)/u)?.[1];
    const bootstrap = await app.fetch(new Request('https://app.example.com/api/bootstrap', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), environment);
    const identity = await app.fetch(new Request('https://app.example.com/api/auth/me', {
      headers: { Cookie: `mail_session=${sessionCookie}` },
    }), environment);

    expect(started.status).toBe(201);
    expect(callback.status).toBe(302);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        kind: 'confirming_organization',
        setup: {
          name: 'Example Owner',
          inboxAddress: 'owner@example.com',
        },
      },
    });
    await expect(identity.json()).resolves.toMatchObject({
      data: {
        email: 'owner@example.com',
        displayName: 'Example Owner',
        accounts: [],
      },
    });
  });
});
