import { createOrganizationKey, encrypt, masterKey, unwrapOrganizationKey } from '../src/cryptography';
import type { Bindings } from '../src/types';
import { createTestApp, type TestApp } from './app';
import { createMemoryR2, type MemoryR2 } from './seed';

const CREATED_AT = '2026-07-25T00:00:00.000Z';
const MASTER_KEY_MATERIAL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface AutomationTestApp extends TestApp {
  environment: Bindings;
  transcriptR2: MemoryR2;
}

export const createAutomationTestApp = async (
  options: { ai?: boolean; enabled?: boolean; lineSecret?: string } = {},
): Promise<AutomationTestApp> => {
  const fixture = createTestApp('owner', { includeAutomationInbox: false });
  const deploymentKey = await masterKey(MASTER_KEY_MATERIAL);
  const wrapped = await createOrganizationKey(deploymentKey, 'v1', 'organization-1');
  const organizationKey = await unwrapOrganizationKey(wrapped, deploymentKey, 'organization-1');
  const googleCredential = await encrypt(
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [],
      tokenType: 'Bearer',
    }),
    organizationKey,
    'google-connection:organization-1:automation-inbox',
  );
  fixture.control.execute(
    `INSERT INTO organization_keys
      (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    'organization-1',
    wrapped.masterKeyVersion,
    JSON.stringify(wrapped.envelope),
    CREATED_AT,
    CREATED_AT,
  );
  fixture.organization.execute(
    `INSERT INTO google_connections
      (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
     VALUES (?, 'automation_inbox', ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    'inbox-1',
    'subject-1',
    'automation@example.com',
    '[]',
    JSON.stringify(googleCredential),
    'history-before-connection',
    options.enabled === false ? 0 : 1,
    CREATED_AT,
    CREATED_AT,
  );
  fixture.organization.execute(
    `INSERT INTO rules
      (id, organization_id, name, status, selection_policy, routing_policy, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', '{}', 0, ?, ?)`,
    'rule-1',
    'organization-1',
    'All dated Source Messages',
    CREATED_AT,
    CREATED_AT,
  );
  if (options.ai) {
    const aiCredential = await encrypt(
      JSON.stringify({
        apiKey: 'api-key',
        baseUrl: 'https://ai.example.com/v1',
        model: 'test-model',
      }),
      organizationKey,
      'organization-connection:organization-1:ai',
    );
    fixture.organization.execute(
      `INSERT INTO connections
        (id, kind, label, credential, status, created_at, updated_at)
       VALUES (?, 'ai', ?, ?, 'active', ?, ?)`,
      'ai-1',
      'OpenAI-compatible API',
      JSON.stringify(aiCredential),
      CREATED_AT,
      CREATED_AT,
    );
  }
  if (options.lineSecret) {
    const lineCredential = await encrypt(
      JSON.stringify({
        channelSecret: options.lineSecret,
        channelAccessToken: 'line-token',
      }),
      organizationKey,
      'organization-connection:organization-1:line',
    );
    fixture.organization.execute(
      `INSERT INTO connections
        (id, kind, label, credential, status, created_at, updated_at)
       VALUES (?, 'line', ?, ?, 'active', ?, ?)`,
      'line-1',
      'LINE',
      JSON.stringify(lineCredential),
      CREATED_AT,
      CREATED_AT,
    );
  }
  fixture.environment.CREDENTIAL_MASTER_KEY = MASTER_KEY_MATERIAL;
  fixture.environment.CREDENTIAL_MASTER_KEY_VERSION = 'v1';
  const transcriptR2 = createMemoryR2();
  fixture.environment.RECOVERY_RECEIPTS = transcriptR2.bucket;
  return { ...fixture, transcriptR2 };
};
