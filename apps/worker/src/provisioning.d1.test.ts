/// <reference types="@cloudflare/vitest-pool-workers" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import controlSchemaMigration from '../migrations/control/0000_initial.sql';
import organizationSchemaMigration from '../migrations/organization/0000_initial.sql';
import { provisionOrganizationDatabase } from './organization-db';

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

describe('Organization schema provisioning through Miniflare D1', () => {
  it('applies the canonical schema to an empty local Organization database', async () => {
    await applyMigration(env.CONTROL_DB, controlSchemaMigration);

    const provisioned = await provisionOrganizationDatabase({
      CONTROL_DB: env.CONTROL_DB,
      LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
    } as unknown as Parameters<typeof provisionOrganizationDatabase>[0], {
      organizationId: 'organization-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    await provisioned.initialize();

    const tables = await provisioned.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();

    expect(tables.results.map(({ name }) => name)).toContain('recipient_profiles');
  });

  it('returns a canonical schema when reusing a migrated local Organization database', async () => {
    await applyMigration(env.CONTROL_DB, controlSchemaMigration);
    await applyMigration(env.LOCAL_ORGANIZATION_DB_1, organizationSchemaMigration);

    const provisioned = await provisionOrganizationDatabase({
      CONTROL_DB: env.CONTROL_DB,
      LOCAL_ORGANIZATION_DB_1: env.LOCAL_ORGANIZATION_DB_1,
    } as unknown as Parameters<typeof provisionOrganizationDatabase>[0], {
      organizationId: 'organization-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    await provisioned.initialize();

    const tables = await provisioned.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();

    expect(tables.results.map(({ name }) => name)).toContain('recipient_profiles');
  });
});
