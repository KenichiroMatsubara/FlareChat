import { createAccountKey, encrypt, masterKey } from '../src/cryptography';
import { controlDatabase } from '../src/storage/database';
import { accountProvisionings, type AccountProvisioningRecord } from '../src/storage/control-schema';
import type { Bindings } from '../src/types';
import { createMigratedTestD1, createTestD1Database, type TestD1Database } from './d1';

const CREATED_AT = '2026-07-26T00:00:00.000Z';
export const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface ProvisioningTestApp {
  control: TestD1Database;
  account: TestD1Database;
  environment: Bindings;
  provisioning: AccountProvisioningRecord;
  close: () => void;
}

export const createProvisioningTestApp = async (): Promise<ProvisioningTestApp> => {
  const control = createMigratedTestD1('control');
  const account = createTestD1Database();
  const deploymentKey = await masterKey(TEST_MASTER_KEY);
  const wrapped = await createAccountKey(deploymentKey, 'v1', 'organization-1');
  const provisioningCredential = await encrypt(
    JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['scope-1'],
      tokenType: 'Bearer',
    }),
    deploymentKey,
    'automation-inbox-token:google-subject-1',
  );
  control.execute(
    'INSERT INTO identities (id, google_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'identity-1',
    'google-owner-1',
    'owner@example.com',
    'Owner',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    `INSERT INTO organizations (id, name, status, binding_name, created_at, updated_at)
     VALUES (?, ?, 'provisioning', ?, ?, ?)`,
    'organization-1',
    'Example Account',
    'ORG_ORGANIZATION1',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    `INSERT INTO admins (organization_id, identity_id, state, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
    'organization-1',
    'identity-1',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    'INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    'session-1',
    'identity-1',
    '2099-01-01T00:00:00.000Z',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    `INSERT INTO organization_keys
      (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    'organization-1',
    'v1',
    JSON.stringify(wrapped.envelope),
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    `INSERT INTO organization_provisionings
      (organization_id, owner_identity_id, state, inbox_address, google_subject, granted_scopes,
       credential_envelope, history_id, binding_name, provisioning_key, expires_at, created_at, updated_at)
     VALUES (?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'organization-1',
    'identity-1',
    'owner@example.com',
    'google-subject-1',
    '["scope-1"]',
    JSON.stringify(provisioningCredential),
    'history-1',
    'ORG_ORGANIZATION1',
    'provisioning-1',
    '2099-01-02T00:00:00.000Z',
    CREATED_AT,
    CREATED_AT,
  );
  const provisioning = await controlDatabase(control.binding).select().from(accountProvisionings).get();
  if (!provisioning) throw new Error('Provisioning test state could not be created.');
  return {
    control,
    account,
    provisioning,
    environment: {
      CONTROL_DB: control.binding,
      LOCAL_ORGANIZATION_DB_1: account.binding,
      CREDENTIAL_MASTER_KEY: TEST_MASTER_KEY,
      CREDENTIAL_MASTER_KEY_VERSION: 'v1',
      APP_URL: 'https://app.example.com',
      WEB_ORIGIN: 'https://app.example.com',
    } as unknown as Bindings,
    close: () => {
      account.close();
      control.close();
    },
  };
};
