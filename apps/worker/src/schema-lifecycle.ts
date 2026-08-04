import organizationInitialMigration from '../migrations/organization/0000_initial.sql';
import organizationTasksMigration from '../migrations/organization/0001_tasks.sql';
import organizationLineDestinationRosterMigration from '../migrations/organization/0002_line_destination_roster.sql';
import organizationReleaseSafeLineDestinationIndexMigration from '../migrations/organization/0003_release_safe_line_destination_index.sql';
import organizationManualLineDestinationSourceMigration from '../migrations/organization/0004_manual_line_destination_source.sql';
import organizationOptionalRecipientEmailMigration from '../migrations/organization/0005_optional_recipient_email.sql';
import organizationOperationalTaskRolesMigration from '../migrations/organization/0006_operational_task_roles.sql';
import organizationSourceMessageDeliveriesMigration from '../migrations/organization/0007_source_message_deliveries.sql';
import organizationRulePermittedListsMigration from '../migrations/organization/0008_rule_permitted_lists.sql';
import organizationPromptsMigration from '../migrations/organization/0009_prompts.sql';
import organizationAgentRulesMigration from '../migrations/organization/0010_agent_rules.sql';
import organizationAgentRunsMigration from '../migrations/organization/0011_agent_runs.sql';
import organizationEventAgentOwnersMigration from '../migrations/organization/0012_event_agent_owners.sql';
import organizationAgentRuleWritesMigration from '../migrations/organization/0013_agent_rule_writes.sql';
import organizationMembersMigration from '../migrations/organization/0014_members.sql';
import organizationAttachmentFoldersMigration from '../migrations/organization/0015_attachment_folders.sql';
import organizationMemberTaskAssignmentsMigration from '../migrations/organization/0016_member_task_assignments.sql';
import organizationMemberPortalMigration from '../migrations/organization/0017_member_portal.sql';

type SchemaKind = 'organization';

interface SchemaMigration {
  name: string;
  sql: string;
}

const ORGANIZATION_MIGRATIONS: readonly SchemaMigration[] = [
  { name: '0000_initial.sql', sql: organizationInitialMigration },
  { name: '0001_tasks.sql', sql: organizationTasksMigration },
  { name: '0002_line_destination_roster.sql', sql: organizationLineDestinationRosterMigration },
  {
    name: '0003_release_safe_line_destination_index.sql',
    sql: organizationReleaseSafeLineDestinationIndexMigration,
  },
  {
    name: '0004_manual_line_destination_source.sql',
    sql: organizationManualLineDestinationSourceMigration,
  },
  {
    name: '0005_optional_recipient_email.sql',
    sql: organizationOptionalRecipientEmailMigration,
  },
  {
    name: '0006_operational_task_roles.sql',
    sql: organizationOperationalTaskRolesMigration,
  },
  {
    name: '0007_source_message_deliveries.sql',
    sql: organizationSourceMessageDeliveriesMigration,
  },
  {
    name: '0008_rule_permitted_lists.sql',
    sql: organizationRulePermittedListsMigration,
  },
  { name: '0009_prompts.sql', sql: organizationPromptsMigration },
  { name: '0010_agent_rules.sql', sql: organizationAgentRulesMigration },
  { name: '0011_agent_runs.sql', sql: organizationAgentRunsMigration },
  { name: '0012_event_agent_owners.sql', sql: organizationEventAgentOwnersMigration },
  { name: '0013_agent_rule_writes.sql', sql: organizationAgentRuleWritesMigration },
  { name: '0014_members.sql', sql: organizationMembersMigration },
  { name: '0015_attachment_folders.sql', sql: organizationAttachmentFoldersMigration },
  { name: '0016_member_task_assignments.sql', sql: organizationMemberTaskAssignmentsMigration },
  { name: '0017_member_portal.sql', sql: organizationMemberPortalMigration },
];
const LEGACY_MIGRATION_CHECKSUMS = new Map<string, ReadonlySet<string>>([
  ['0001_tasks.sql', new Set(['4b2f3889191d0eafbbe45b78103db7139c7ce2b937c02cbbb6824f5131d7429f'])],
]);
export const ORGANIZATION_SCHEMA_TARGET =
  ORGANIZATION_MIGRATIONS.at(-1)?.name ?? '';

const migrations = (kind: SchemaKind): readonly SchemaMigration[] => {
  switch (kind) {
    case 'organization':
      return ORGANIZATION_MIGRATIONS;
  }
};

const statements = (migration: string): string[] =>
  migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

const checksum = async (sql: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const hasChecksumColumn = async (database: D1Database): Promise<boolean> => {
  const columns = await database.prepare('PRAGMA table_info(d1_migrations)').all<{ name: string }>();
  return columns.results.some(({ name }) => name === 'checksum');
};

const ensureChecksumColumn = async (database: D1Database): Promise<void> => {
  if (await hasChecksumColumn(database)) return;
  try {
    await database.prepare('ALTER TABLE d1_migrations ADD COLUMN checksum TEXT').run();
  } catch (error) {
    if (!await hasChecksumColumn(database)) throw error;
  }
};

export interface SchemaReceipt {
  kind: SchemaKind;
  currentMigration: string;
  appliedMigrations: string[];
}

export const schemaLifecycle = {
  async ensureCurrent(input: {
    kind: SchemaKind;
    database: D1Database;
  }): Promise<SchemaReceipt> {
    await input.database.prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, checksum TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    ).run();
    await ensureChecksumColumn(input.database);
    const manifest = migrations(input.kind);
    const manifestWithChecksums = await Promise.all(manifest.map(async (migration) => ({
      ...migration,
      checksum: await checksum(migration.sql),
    })));
    const applied = await input.database.prepare(
      'SELECT name, checksum FROM d1_migrations',
    ).all<{ name: string; checksum: string | null }>();
    const expectedChecksums = new Map(
      manifestWithChecksums.map((migration) => [migration.name, migration.checksum]),
    );
    for (const migration of applied.results) {
      const expected = expectedChecksums.get(migration.name);
      if (!expected) continue;
      if (migration.checksum && migration.checksum !== expected
        && !LEGACY_MIGRATION_CHECKSUMS.get(migration.name)?.has(migration.checksum)) {
        throw new Error(`Migration checksum mismatch for ${migration.name}.`);
      }
      if (!migration.checksum) {
        await input.database.prepare(
          'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
        ).bind(expected, migration.name).run();
      }
    }
    const appliedNames = new Set(applied.results.map(({ name }) => name));
    const appliedMigrations: string[] = [];
    for (const migration of manifestWithChecksums) {
      if (appliedNames.has(migration.name)) continue;
      try {
        await input.database.batch([
          ...statements(migration.sql).map((statement) => input.database.prepare(statement)),
          input.database.prepare(
            'INSERT INTO d1_migrations (name, checksum) VALUES (?, ?)',
          ).bind(migration.name, migration.checksum),
        ]);
        appliedMigrations.push(migration.name);
      } catch (error) {
        const raced = await input.database.prepare(
          'SELECT checksum FROM d1_migrations WHERE name = ?',
        ).bind(migration.name).first<{ checksum: string | null }>();
        if (!raced) throw error;
        if (raced.checksum && raced.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.name}.`);
        }
        if (!raced.checksum) {
          await input.database.prepare(
            'UPDATE d1_migrations SET checksum = ? WHERE name = ?',
          ).bind(migration.checksum, migration.name).run();
        }
      }
    }
    return {
      kind: input.kind,
      currentMigration: manifest.at(-1)?.name ?? '',
      appliedMigrations,
    };
  },
};
