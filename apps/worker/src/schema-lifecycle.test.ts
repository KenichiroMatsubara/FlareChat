import { readdirSync } from 'node:fs';
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

describe('Schema Lifecycle', () => {
  it('makes a partially migrated Organization database ready for current code', async () => {
    const database = databaseAtInitialOrganizationSchema();

    const receipt = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: database.binding,
    });

    expect(receipt).toMatchObject({
      kind: 'organization',
      currentMigration: '0004_manual_line_destination_source.sql',
      appliedMigrations: [
        '0001_tasks.sql',
        '0002_line_destination_roster.sql',
        '0003_release_safe_line_destination_index.sql',
        '0004_manual_line_destination_source.sql',
      ],
    });
    expect(database.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
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
      currentMigration: '0004_manual_line_destination_source.sql',
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
      expect.objectContaining({ currentMigration: '0004_manual_line_destination_source.sql' }),
      expect.objectContaining({ currentMigration: '0004_manual_line_destination_source.sql' }),
    ]);
  });
});
