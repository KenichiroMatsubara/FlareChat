/// <reference types="@cloudflare/vitest-pool-workers" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import accountSchemaMigration from '../migrations/organization/0000_initial.sql';
import { provisionAccountDatabase } from './account-db';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    CONTROL_DB: D1Database;
    LOCAL_ORGANIZATION_DB_1: D1Database;
  }
}

const applyMigration = async (database: D1Database, migration: string): Promise<void> => {
  const statements = migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
};

describe('Account schema provisioning through Miniflare D1', () => {
  it('applies the canonical schema to an empty local Account database', async () => {
    await applyMigration(env.CONTROL_DB, controlSchemaMigration);

    const provisioned = await provisionAccountDatabase({
      CONTROL_DB: env.CONTROL_DB,
      LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
    } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    await provisioned.initialize();

    const tables = await provisioned.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();

    expect(tables.results.map(({ name }) => name)).toContain('members');
  });

  it('returns a canonical schema when reusing a migrated local Account database', async () => {
    await applyMigration(env.CONTROL_DB, controlSchemaMigration);
    await applyMigration(env.LOCAL_ORGANIZATION_DB_1, accountSchemaMigration);
    await env.LOCAL_ORGANIZATION_DB_1.batch([
      env.LOCAL_ORGANIZATION_DB_1.prepare(
        'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
      ),
      env.LOCAL_ORGANIZATION_DB_1.prepare(
        'INSERT INTO d1_migrations (name) VALUES (?)',
      ).bind('0000_initial.sql'),
      env.LOCAL_ORGANIZATION_DB_1.prepare(
        'CREATE TABLE provisioning_regression_marker (value TEXT NOT NULL)',
      ),
      env.LOCAL_ORGANIZATION_DB_1.prepare(
        'INSERT INTO provisioning_regression_marker (value) VALUES (?)',
      ).bind('must survive retry'),
    ]);

    const provisioned = await provisionAccountDatabase({
      CONTROL_DB: env.CONTROL_DB,
      LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
    } as unknown as Parameters<typeof provisionAccountDatabase>[0], {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    await provisioned.initialize();

    const tables = await provisioned.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const marker = await provisioned.database
      .prepare('SELECT value FROM provisioning_regression_marker')
      .first<{ value: string }>();

    expect(tables.results.map(({ name }) => name)).toContain('members');
    expect(tables.results.map(({ name }) => name)).toContain('tasks');
    expect(marker).toEqual({ value: 'must survive retry' });
  });
});
