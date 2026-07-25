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
