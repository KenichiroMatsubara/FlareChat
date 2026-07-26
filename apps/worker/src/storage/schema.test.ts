import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createMigratedTestD1 } from '../../test/d1';
import { connections, googleConnections } from './organization-schema';

const migrations = (kind: 'control' | 'organization'): string[] =>
  readdirSync(resolve(import.meta.dirname, `../../migrations/${kind}`))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const migrationSql = (kind: 'control' | 'organization'): string =>
  readFileSync(resolve(import.meta.dirname, `../../migrations/${kind}/0000_initial.sql`), 'utf8');

const applicationSources = (): Array<{ name: string; source: string }> => {
  const sourceRoot = resolve(import.meta.dirname, '..');
  const infrastructure = new Set([
    'cloudflare.ts',
    'organization-db.ts',
    'storage/database.ts',
  ]);
  return readdirSync(sourceRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !infrastructure.has(name))
    .map((name) => ({ name, source: readFileSync(resolve(sourceRoot, name), 'utf8') }));
};

const tableNames = (kind: 'control' | 'organization'): string[] => {
  const database = createMigratedTestD1(kind);
  try {
    return database.rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => row.name);
  } finally {
    database.close();
  }
};

describe('canonical D1 schemas', () => {
  it('has one Drizzle-generated initial migration per database kind', () => {
    expect(migrations('control')).toEqual(['0000_initial.sql']);
    expect(migrations('organization')).toEqual(['0000_initial.sql']);
  });

  it('creates only Control-plane tables in Control D1', () => {
    expect(tableNames('control')).toEqual([
      'gemini_oauth_states',
      'google_login_states',
      'identities',
      'members',
      'organization_keys',
      'organization_setups',
      'organizations',
      'recovery_requests',
      'sessions',
    ]);
    expect(migrationSql('control')).not.toMatch(
      /google_automations|automation_messages|organization_connections|passkeys|setup_sessions/u,
    );
  });

  it('models the Automation Inbox only in Organization D1', () => {
    expect(tableNames('organization')).toContain('google_connections');
    expect(tableNames('organization')).not.toContain('schema_migrations');
    expect(migrationSql('organization')).not.toMatch(/schema_migrations|kind.+google.+line.+ai/u);
  });

  it('rejects the removed generic Google connection shape at the type seam', () => {
    type AutomationInboxKind = typeof googleConnections.$inferInsert.kind;
    type OrganizationConnectionKind = typeof connections.$inferInsert.kind;

    expectTypeOf<AutomationInboxKind>().toEqualTypeOf<'automation_inbox'>();
    expectTypeOf<OrganizationConnectionKind>().toEqualTypeOf<'line' | 'ai'>();
  });

  it('keeps handwritten D1 statements out of application persistence', () => {
    const offenders = applicationSources()
      .filter(({ source }) => source.includes('.prepare('))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
