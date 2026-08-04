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

const workerPackage = (): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

const rootPackage = (): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

const applicationSources = (): Array<{ name: string; source: string }> => {
  const sourceRoot = resolve(import.meta.dirname, '..');
  const infrastructure = new Set([
    'cloudflare.ts',
    'organization-db.ts',
    'schema-lifecycle.ts',
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
    expect(migrations('control')).toEqual([
      '0000_initial.sql',
      '0001_schema_release.sql',
      '0002_preset_selection.sql',
      '0003_admins.sql',
      '0004_single_admin_role.sql',
      '0005_member_logins.sql',
    ]);
    expect(migrations('organization')).toEqual([
      '0000_initial.sql',
      '0001_tasks.sql',
      '0002_line_destination_roster.sql',
      '0003_release_safe_line_destination_index.sql',
      '0004_manual_line_destination_source.sql',
      '0005_optional_recipient_email.sql',
      '0006_operational_task_roles.sql',
      '0007_source_message_deliveries.sql',
      '0008_rule_permitted_lists.sql',
      '0009_prompts.sql',
      '0010_agent_rules.sql',
      '0011_agent_runs.sql',
      '0012_event_agent_owners.sql',
      '0013_agent_rule_writes.sql',
      '0014_members.sql',
      '0015_attachment_folders.sql',
      '0016_member_task_assignments.sql',
      '0017_member_portal.sql',
    ]);
  });

  it('applies local D1 migrations before starting the Worker dev server', () => {
    expect(workerPackage().scripts?.predev).toBe('npm run db:local');
  });

  it('migrates and verifies the production database fleet before promoting Worker code', () => {
    expect(rootPackage().scripts?.['deploy:cloudflare']).toBe(
      'npm run db:migrate:control:remote && npm run db:migrate:organization:remote && npm run deploy:worker:release -w @mail/worker && npm run db:migrate:complete:remote',
    );
  });

  it('creates only Control-plane tables in Control D1', () => {
    expect(tableNames('control')).toEqual([
      'admins',
      'automation_inbox_claims',
      'd1_migrations',
      'identities',
      'member_logins',
      'oauth_flows',
      'organization_keys',
      'organization_provisionings',
      'organization_setups',
      'organizations',
      'recovery_requests',
      'schema_releases',
      'sessions',
    ]);
    expect(migrationSql('control')).not.toMatch(
      /google_automations|automation_messages|organization_connections|passkeys|setup_sessions/u,
    );
  });

  it('models the Automation Inbox only in Organization D1', () => {
    expect(tableNames('organization')).toContain('google_connections');
    expect(tableNames('organization')).toContain('d1_migrations');
    expect(tableNames('organization')).not.toContain('schema_migrations');
    expect(migrationSql('organization')).not.toMatch(/schema_migrations|kind.+google.+line.+ai/u);
  });

  it('constrains every Scheduled Event to exactly one Schema or Agent Owning Rule', () => {
    const database = createMigratedTestD1('organization');
    try {
      database.execute("INSERT INTO rules (id, organization_id, name, status, created_at, updated_at) VALUES ('schema-rule', 'organization-1', 'Schema', 'active', '2026-08-01', '2026-08-01')");
      database.execute("INSERT INTO prompts (id, organization_id, name, instructions, created_at, updated_at) VALUES ('prompt-1', 'organization-1', 'Prompt', 'Read.', '2026-08-01', '2026-08-01')");
      database.execute("INSERT INTO agent_rules (id, organization_id, name, status, prompt_id, created_at, updated_at) VALUES ('agent-rule', 'organization-1', 'Agent', 'active', 'prompt-1', '2026-08-01', '2026-08-01')");
      const event = (id: string, ruleId: string, agentRuleId: string): string =>
        `INSERT INTO events (id, organization_id, rule_id, agent_rule_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('${id}', 'organization-1', ${ruleId}, ${agentRuleId}, 'Event', '2026-09-01', '2026-09-02', 'scheduled', '2026-08-01', '2026-08-01')`;

      expect(() => database.execute(event('neither', 'NULL', 'NULL'))).toThrow();
      expect(() => database.execute(event('both', "'schema-rule'", "'agent-rule'"))).toThrow();
      expect(() => database.execute(event('schema-owned', "'schema-rule'", 'NULL'))).not.toThrow();
      expect(() => database.execute(event('agent-owned', 'NULL', "'agent-rule'"))).not.toThrow();
    } finally {
      database.close();
    }
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
