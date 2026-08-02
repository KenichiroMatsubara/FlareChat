import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import organizationInitialMigration from '../migrations/organization/0000_initial.sql';
import { createTestD1Database, type TestD1Database } from '../test/d1';
import { schemaLifecycle } from './schema-lifecycle';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const databaseAtInitialOrganizationSchema = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  for (const statement of organizationInitialMigration
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

const databaseBeforeOperationalTaskRoles = (): TestD1Database => {
  const database = createTestD1Database();
  openDatabases.push(database);
  const migrationDirectory = resolve(import.meta.dirname, '../migrations/organization');
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0006_operational_task_roles.sql')
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory, name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.execute(statement);
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  return database;
};

describe('Schema Lifecycle', () => {
  it('makes a partially migrated Organization database ready for current code', async () => {
    const database = databaseAtInitialOrganizationSchema();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    });

    expect(receipt).toMatchObject({
      kind: 'organization',
      currentMigration: '0007_source_message_deliveries.sql',
      appliedMigrations: [
        '0001_tasks.sql',
        '0002_line_destination_roster.sql',
        '0003_release_safe_line_destination_index.sql',
        '0004_manual_line_destination_source.sql',
        '0005_optional_recipient_email.sql',
        '0006_operational_task_roles.sql',
        '0007_source_message_deliveries.sql',
      ],
    });
    expect(database.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
    database.execute(
      "INSERT INTO recipient_profiles (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('recipient-1', 'organization-1', 'First', '', 'active', '[]', '2026-01-01', '2026-01-01')",
    );
    database.execute(
      "INSERT INTO recipient_profiles (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES ('recipient-2', 'organization-1', 'Second', '', 'active', '[]', '2026-01-01', '2026-01-01')",
    );
    expect(database.rows<{ email: string }>('SELECT email FROM recipient_profiles')).toEqual([
      { email: '' },
      { email: '' },
    ]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('can retry a migration after a failed batch leaves the database unchanged', async () => {
    const database = databaseAtInitialOrganizationSchema();
    database.execute(
      'CREATE INDEX tasks_source_role_deadline_title_idx ON source_messages(id)',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).rejects.toThrow();

    database.execute('DROP INDEX tasks_source_role_deadline_title_idx');

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).resolves.toMatchObject({
      currentMigration: '0007_source_message_deliveries.sql',
    });
  });

  it('rejects an applied migration whose recorded checksum no longer matches', async () => {
    const database = databaseAtInitialOrganizationSchema();
    database.execute('ALTER TABLE d1_migrations ADD COLUMN checksum TEXT');
    database.execute(
      'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
      'modified-after-application',
      '0000_initial.sql',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).rejects.toThrow(/checksum/u);
  });

  it('accepts the recorded checksum from the constrained Task schema and migrates it forward', async () => {
    const database = databaseAtInitialOrganizationSchema();
    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });
    database.execute(
      'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
      '4b2f3889191d0eafbbe45b78103db7139c7ce2b937c02cbbb6824f5131d7429f',
      '0001_tasks.sql',
    );

    await expect(schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    })).resolves.toMatchObject({ currentMigration: '0007_source_message_deliveries.sql' });
  });

  it('migrates existing assignments and Tasks into Organization-owned role records without losing snapshots', async () => {
    const database = databaseBeforeOperationalTaskRoles();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')");
    database.execute("INSERT INTO task_role_assignments (role, identity_id, display_name, assigned_at, updated_at) VALUES ('legacy-registration', 'identity-1', 'Owner', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_role, assignee_identity_id, assignee_name, description, created_at, updated_at) VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '登録する', '2026-08-20', 'legacy-registration', 'identity-1', 'Owner', '登録を行う', '2026-08-01', '2026-08-01')");

    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });

    expect(database.rows<{ id: string; display_name: string }>('SELECT id, display_name FROM operational_task_roles')).toEqual([
      { id: 'legacy-registration', display_name: 'legacy-registration' },
    ]);
    expect(database.rows<{ assignee_role_id: string; assignee_role_name: string; assignee_name: string }>('SELECT assignee_role_id, assignee_role_name, assignee_name FROM tasks')).toEqual([
      { assignee_role_id: 'legacy-registration', assignee_role_name: 'legacy-registration', assignee_name: 'Owner' },
    ]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps existing Event Delivery Records intact when Source Message references are added', async () => {
    const database = databaseBeforeOperationalTaskRoles();
    database.execute("INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')");
    database.execute("INSERT INTO events (id, organization_id, source_message_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('event-1', 'organization-1', 'source-1', '年次行事', '2026-09-01T10:00:00+09:00', '2026-09-01T12:00:00+09:00', 'scheduled', '2026-08-01', '2026-08-01')");
    database.execute("INSERT INTO deliveries (id, event_id, channel, destination, outcome, external_id, created_at) VALUES ('delivery-1', 'event-1', 'calendar', 'reader@example.com', 'succeeded', 'google-event-1', '2026-08-01')");

    await schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding });

    expect(database.rows<{ id: string; event_id: string | null; source_message_id: string | null }>(
      'SELECT id, event_id, source_message_id FROM deliveries',
    )).toEqual([{
      id: 'delivery-1',
      event_id: 'event-1',
      source_message_id: null,
    }]);
    expect(database.rows('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('includes every checked-in Organization migration in the current schema', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    const checkedInMigrations = readdirSync(resolve(
      import.meta.dirname,
      '../migrations/organization',
    )).filter((name) => name.endsWith('.sql')).sort();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    });

    expect(receipt.appliedMigrations).toEqual(checkedInMigrations);
  });

  it('converges when two callers migrate the same Organization database concurrently', async () => {
    const database = databaseAtInitialOrganizationSchema();

    const receipts = await Promise.all([
      schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }),
      schemaLifecycle.ensureCurrent({ kind: 'organization', database: database.binding }),
    ]);

    expect(receipts).toEqual([
      expect.objectContaining({ currentMigration: '0007_source_message_deliveries.sql' }),
      expect.objectContaining({ currentMigration: '0007_source_message_deliveries.sql' }),
    ]);
  });
});
