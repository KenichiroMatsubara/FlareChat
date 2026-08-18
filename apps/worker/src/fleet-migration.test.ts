import { afterEach, describe, expect, it, vi } from 'vitest';

import accountInitialMigration from '../migrations/organization/0000_initial.sql';
import { createMigratedTestD1, createTestD1Database, type TestD1Database } from '../test/d1';
import { seedAccountRoute } from '../test/seed';
import { fleetMigration } from './fleet-migration';
import type { Bindings } from './types';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of openDatabases.splice(0)) database.close();
});

const initialAccountDatabase = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  for (const statement of accountInitialMigration
    .split('--> statement-breakpoint')
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  database.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
  return database;
};

describe('Fleet Migration', () => {
  it('pauses Account provisioning until the prepared release is completed', async () => {
    const control = createMigratedTestD1('control');
    openDatabases.push(control);
    const environment = { CONTROL_DB: control.binding } as unknown as Bindings;

    await fleetMigration.prepareRelease(environment);

    await expect(fleetMigration.provisioningAllowed(environment)).resolves.toBe(false);

    await fleetMigration.completeRelease(environment);

    await expect(fleetMigration.provisioningAllowed(environment)).resolves.toBe(true);
  });

  it('does not replace a different schema release already in progress', async () => {
    const control = createMigratedTestD1('control');
    openDatabases.push(control);
    control.execute(
      `UPDATE schema_releases
       SET state = 'migrating', target_migration = ?
       WHERE id = 'organization'`,
      'future-migration.sql',
    );

    await expect(fleetMigration.prepareRelease({
      CONTROL_DB: control.binding,
    } as unknown as Bindings)).rejects.toThrow(/another schema release/iu);
  });

  it('makes every recorded Account database current before release', async () => {
    const control = createMigratedTestD1('control');
    const active = initialAccountDatabase();
    const suspended = initialAccountDatabase();
    openDatabases.push(control);
    seedAccountRoute(control, {
      id: 'organization-active',
      bindingName: 'ORG_ACTIVE',
      status: 'active',
    });
    seedAccountRoute(control, {
      id: 'organization-suspended',
      bindingName: 'ORG_SUSPENDED',
      status: 'suspended',
    });

    const receipt = await fleetMigration.prepareRelease({
      CONTROL_DB: control.binding,
      ORG_ACTIVE: active.binding,
      ORG_SUSPENDED: suspended.binding,
    } as unknown as Bindings);

    expect(receipt).toMatchObject({
      targetMigration: '0021_rule_execution.sql',
      migratedDatabases: 2,
    });
    expect(active.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
    expect(suspended.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
  });

  it('migrates an unbound production Account database by its recorded database ID', async () => {
    const control = createMigratedTestD1('control');
    openDatabases.push(control);
    seedAccountRoute(control, {
      id: 'organization-production',
      bindingName: 'ORG_PRODUCTION',
      databaseId: 'database-production',
    });
    const applied = new Map<string, string | null>([['0000_initial.sql', null]]);
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        batch?: Array<{ sql: string; params: unknown[] }>;
        sql?: string;
        params?: unknown[];
      };
      if (body.batch) {
        for (const query of body.batch) {
          if (query.sql.startsWith('INSERT INTO d1_migrations')) {
            applied.set(String(query.params[0]), String(query.params[1]));
          }
        }
        return Response.json({
          success: true,
          result: body.batch.map(() => ({ success: true, results: [], meta: {} })),
        });
      }
      const results = body.sql === 'PRAGMA table_info(d1_migrations)'
        ? ['id', 'name', 'checksum', 'applied_at'].map((name) => ({ name }))
        : body.sql === 'SELECT name, checksum FROM d1_migrations'
          ? [...applied].map(([name, checksum]) => ({ name, checksum }))
          : body.sql === 'SELECT checksum FROM d1_migrations WHERE name = ?'
            ? applied.has(String(body.params?.[0]))
              ? [{ checksum: applied.get(String(body.params?.[0])) }]
              : []
            : [];
      return Response.json({
        success: true,
        result: [{ success: true, results, meta: {} }],
      });
    }));

    const receipt = await fleetMigration.prepareRelease({
      CONTROL_DB: control.binding,
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      CLOUDFLARE_API_TOKEN: 'token-1',
    } as unknown as Bindings);

    expect(receipt).toMatchObject({
      targetMigration: '0021_rule_execution.sql',
      migratedDatabases: 1,
    });
    expect(applied.has('0004_manual_line_destination_source.sql')).toBe(true);
    expect(applied.has('0006_operational_task_roles.sql')).toBe(true);
    expect(applied.has('0007_source_message_deliveries.sql')).toBe(true);
    expect(applied.has('0008_rule_permitted_lists.sql')).toBe(true);
  });

  it('includes an allocated database that is still in Account provisioning', async () => {
    const control = createMigratedTestD1('control');
    const provisioning = initialAccountDatabase();
    openDatabases.push(control);
    const timestamp = '2026-07-31T00:00:00.000Z';
    control.execute(
      `INSERT INTO organizations
        (id, name, status, database_id, binding_name, created_at, updated_at)
       VALUES (?, ?, 'provisioning', NULL, ?, ?, ?)`,
      'organization-provisioning',
      'Provisioning Account',
      'ORG_PROVISIONING',
      timestamp,
      timestamp,
    );
    control.execute(
      `INSERT INTO identities
        (id, google_subject, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'identity-provisioning',
      'google-provisioning',
      'owner@example.com',
      'Owner',
      timestamp,
      timestamp,
    );
    control.execute(
      `INSERT INTO organization_provisionings
        (organization_id, owner_identity_id, state, inbox_address, google_subject,
         granted_scopes, credential_envelope, history_id, database_id, binding_name,
         provisioning_key, expires_at, created_at, updated_at)
       VALUES (?, ?, 'provisioning', ?, ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?)`,
      'organization-provisioning',
      'identity-provisioning',
      'owner@example.com',
      'google-provisioning',
      'history-provisioning',
      'local:ORG_PROVISIONING',
      'ORG_PROVISIONING',
      'provisioning-key',
      '2099-01-01T00:00:00.000Z',
      timestamp,
      timestamp,
    );

    const receipt = await fleetMigration.prepareRelease({
      CONTROL_DB: control.binding,
      ORG_PROVISIONING: provisioning.binding,
    } as unknown as Bindings);

    expect(receipt.migratedDatabases).toBe(1);
    expect(provisioning.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
  });
});
