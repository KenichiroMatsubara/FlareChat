import type { Bindings } from '../src/types';
import { createMigratedTestD1, type TestD1Database } from './d1';
import { seedOrganizationRoute } from './seed';

const CREATED_AT = '2026-07-25T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

export type OrganizationRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface TestApp {
  control: TestD1Database;
  organization: TestD1Database;
  environment: Bindings;
  request: (path: string, init?: RequestInit) => Request;
  jsonRequest: (path: string, body: unknown, method?: string) => Request;
  addOrganization: (input: {
    id: string;
    bindingName: string;
    role?: OrganizationRole;
    name?: string;
  }) => TestD1Database;
  close: () => void;
}

export const createTestApp = (
  role: OrganizationRole = 'owner',
  options: { includeAutomationInbox?: boolean } = {},
): TestApp => {
  const control = createMigratedTestD1('control');
  const organization = createMigratedTestD1('organization');
  const additionalDatabases: TestD1Database[] = [];
  seedOrganizationRoute(control, {
    id: 'organization-1',
    bindingName: 'ORG_ORGANIZATION1',
    databaseId: 'database-1',
    name: 'Organization One',
  });
  control.execute(
    'INSERT INTO identities (id, google_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'identity-1',
    'google-subject-1',
    'owner@example.com',
    'Owner',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    'INSERT INTO members (organization_id, identity_id, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'organization-1',
    'identity-1',
    role,
    'active',
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    'INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    'session-1',
    'identity-1',
    FUTURE,
    CREATED_AT,
    CREATED_AT,
  );
  if (options.includeAutomationInbox !== false) {
    control.execute(
      `INSERT INTO automation_inbox_claims
        (google_subject, inbox_address, organization_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      'google-subject-1',
      'owner@example.com',
      'organization-1',
      CREATED_AT,
      CREATED_AT,
    );
    organization.execute(
      `INSERT INTO google_connections
        (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, enabled, status, created_at, updated_at)
       VALUES (?, 'automation_inbox', ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      'google-1',
      'google-subject-1',
      'owner@example.com',
      '[]',
      '{}',
      'history-1',
      CREATED_AT,
      CREATED_AT,
    );
  }
  const environment = {
    CONTROL_DB: control.binding,
    ORG_ORGANIZATION1: organization.binding,
    RECOVERY_RECEIPTS: {} as R2Bucket,
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
  } as unknown as Bindings;
  const request = (path: string, init: RequestInit = {}): Request => new Request(
    `https://app.example.com${path}`,
    {
      ...init,
      headers: { Cookie: 'mail_session=session-1', ...init.headers },
    },
  );
  return {
    control,
    organization,
    environment,
    request,
    jsonRequest: (path, body, method = 'POST') => request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    addOrganization: (input) => {
      const database = createMigratedTestD1('organization');
      additionalDatabases.push(database);
      seedOrganizationRoute(control, {
        id: input.id,
        bindingName: input.bindingName,
        databaseId: `database-${input.id}`,
        name: input.name ?? input.id,
      });
      control.execute(
        'INSERT INTO members (organization_id, identity_id, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        input.id,
        'identity-1',
        input.role ?? role,
        'active',
        CREATED_AT,
        CREATED_AT,
      );
      (environment as unknown as Record<string, unknown>)[input.bindingName] = database.binding;
      return database;
    },
    close: () => {
      for (const database of additionalDatabases) database.close();
      organization.close();
      control.close();
    },
  };
};
