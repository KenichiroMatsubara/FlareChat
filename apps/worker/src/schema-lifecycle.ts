import controlInitialMigration from '../migrations/control/0000_initial.sql';
import controlSchemaReleaseMigration from '../migrations/control/0001_schema_release.sql';
import controlPresetSelectionMigration from '../migrations/control/0002_preset_selection.sql';
import controlAccountIdentitiesMigration from '../migrations/control/0003_admins.sql';
import controlSingleAccountIdentityRoleMigration from '../migrations/control/0004_single_admin_role.sql';
import controlContactLoginsMigration from '../migrations/control/0005_member_logins.sql';
import accountInitialMigration from '../migrations/organization/0000_initial.sql';
import accountTasksMigration from '../migrations/organization/0001_tasks.sql';
import accountLineDestinationRosterMigration from '../migrations/organization/0002_line_destination_roster.sql';
import accountReleaseSafeLineDestinationIndexMigration from '../migrations/organization/0003_release_safe_line_destination_index.sql';
import accountManualLineDestinationSourceMigration from '../migrations/organization/0004_manual_line_destination_source.sql';
import accountOptionalRecipientEmailMigration from '../migrations/organization/0005_optional_recipient_email.sql';
import accountOperationalTaskRolesMigration from '../migrations/organization/0006_operational_task_roles.sql';
import accountSourceMessageDeliveriesMigration from '../migrations/organization/0007_source_message_deliveries.sql';
import accountRulePermittedListsMigration from '../migrations/organization/0008_rule_permitted_lists.sql';
import accountPromptsMigration from '../migrations/organization/0009_prompts.sql';
import accountAgentRulesMigration from '../migrations/organization/0010_agent_rules.sql';
import accountAgentRunsMigration from '../migrations/organization/0011_agent_runs.sql';
import accountEventAgentOwnersMigration from '../migrations/organization/0012_event_agent_owners.sql';
import accountAgentRuleWritesMigration from '../migrations/organization/0013_agent_rule_writes.sql';
import accountContactsMigration from '../migrations/organization/0014_members.sql';
import accountAttachmentFoldersMigration from '../migrations/organization/0015_attachment_folders.sql';
import accountContactTaskAssignmentsMigration from '../migrations/organization/0016_member_task_assignments.sql';
import accountContactPortalMigration from '../migrations/organization/0017_member_portal.sql';
import accountAutomationInboxHealthMigration from '../migrations/organization/0018_automation_inbox_health.sql';
import accountTaskRoleRevisionsMigration from '../migrations/organization/0019_task_role_revisions.sql';
import accountEventResponsesAndGuestsMigration from '../migrations/organization/0020_event_responses_and_guests.sql';
import accountRuleExecutionMigration from '../migrations/organization/0021_rule_execution.sql';
import accountOperatorChatMigration from '../migrations/organization/0022_operator_chat.sql';

type SchemaKind = 'control' | 'organization';

interface SchemaMigration {
  name: string;
  sql: string;
}

export type SchemaReadinessCategory =
  | 'database_ahead'
  | 'migration_history_missing'
  | 'migration_history_mismatch'
  | 'checksum_mismatch'
  | 'migration_apply_failed';

export class SchemaReadinessError extends Error {
  readonly category: SchemaReadinessCategory;
  readonly kind: SchemaKind;
  readonly currentMigration: string;
  readonly expectedMigration: string;
  readonly databaseId: string | null | undefined;
  readonly bindingName: string | undefined;

  constructor(input: {
    category: SchemaReadinessCategory;
    kind: SchemaKind;
    currentMigration: string;
    expectedMigration: string;
    databaseId?: string | null;
    bindingName?: string;
    cause?: unknown;
  }) {
    super(
      `${input.kind} database schema is not ready: ${input.category} `
      + `(current ${input.currentMigration || 'none'}, expected ${input.expectedMigration || 'none'}).`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'SchemaReadinessError';
    this.category = input.category;
    this.kind = input.kind;
    this.currentMigration = input.currentMigration;
    this.expectedMigration = input.expectedMigration;
    this.databaseId = input.databaseId;
    this.bindingName = input.bindingName;
  }
}

const CONTROL_MIGRATIONS: readonly SchemaMigration[] = [
  { name: '0000_initial.sql', sql: controlInitialMigration },
  { name: '0001_schema_release.sql', sql: controlSchemaReleaseMigration },
  { name: '0002_preset_selection.sql', sql: controlPresetSelectionMigration },
  { name: '0003_admins.sql', sql: controlAccountIdentitiesMigration },
  { name: '0004_single_admin_role.sql', sql: controlSingleAccountIdentityRoleMigration },
  { name: '0005_member_logins.sql', sql: controlContactLoginsMigration },
];

const ORGANIZATION_MIGRATIONS: readonly SchemaMigration[] = [
  { name: '0000_initial.sql', sql: accountInitialMigration },
  { name: '0001_tasks.sql', sql: accountTasksMigration },
  { name: '0002_line_destination_roster.sql', sql: accountLineDestinationRosterMigration },
  {
    name: '0003_release_safe_line_destination_index.sql',
    sql: accountReleaseSafeLineDestinationIndexMigration,
  },
  {
    name: '0004_manual_line_destination_source.sql',
    sql: accountManualLineDestinationSourceMigration,
  },
  {
    name: '0005_optional_recipient_email.sql',
    sql: accountOptionalRecipientEmailMigration,
  },
  {
    name: '0006_operational_task_roles.sql',
    sql: accountOperationalTaskRolesMigration,
  },
  {
    name: '0007_source_message_deliveries.sql',
    sql: accountSourceMessageDeliveriesMigration,
  },
  {
    name: '0008_rule_permitted_lists.sql',
    sql: accountRulePermittedListsMigration,
  },
  { name: '0009_prompts.sql', sql: accountPromptsMigration },
  { name: '0010_agent_rules.sql', sql: accountAgentRulesMigration },
  { name: '0011_agent_runs.sql', sql: accountAgentRunsMigration },
  { name: '0012_event_agent_owners.sql', sql: accountEventAgentOwnersMigration },
  { name: '0013_agent_rule_writes.sql', sql: accountAgentRuleWritesMigration },
  { name: '0014_members.sql', sql: accountContactsMigration },
  { name: '0015_attachment_folders.sql', sql: accountAttachmentFoldersMigration },
  { name: '0016_member_task_assignments.sql', sql: accountContactTaskAssignmentsMigration },
  { name: '0017_member_portal.sql', sql: accountContactPortalMigration },
  { name: '0018_automation_inbox_health.sql', sql: accountAutomationInboxHealthMigration },
  { name: '0019_task_role_revisions.sql', sql: accountTaskRoleRevisionsMigration },
  { name: '0020_event_responses_and_guests.sql', sql: accountEventResponsesAndGuestsMigration },
  { name: '0021_rule_execution.sql', sql: accountRuleExecutionMigration },
  { name: '0022_operator_chat.sql', sql: accountOperatorChatMigration },
];
const LEGACY_MIGRATION_CHECKSUMS = new Map<string, ReadonlySet<string>>([
  ['0001_tasks.sql', new Set(['4b2f3889191d0eafbbe45b78103db7139c7ce2b937c02cbbb6824f5131d7429f'])],
  [
    '0006_operational_task_roles.sql',
    new Set(['7c37ad2276cf9819a1e58105345d18816d4e15ea0b850399b11e3fa641c9eb2e']),
  ],
]);
export const ORGANIZATION_SCHEMA_TARGET =
  ORGANIZATION_MIGRATIONS.at(-1)?.name ?? '';
export const CONTROL_SCHEMA_TARGET = CONTROL_MIGRATIONS.at(-1)?.name ?? '';

const migrations = (kind: SchemaKind): readonly SchemaMigration[] => {
  switch (kind) {
    case 'control':
      return CONTROL_MIGRATIONS;
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
    const manifest = migrations(input.kind);
    const expectedMigration = manifest.at(-1)?.name ?? '';
    const ledger = await input.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
    ).first<{ name: string }>();
    if (!ledger) {
      const existingSchema = await input.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' LIMIT 1",
      ).first<{ name: string }>();
      if (existingSchema) {
        throw new SchemaReadinessError({
          category: 'migration_history_missing',
          kind: input.kind,
          currentMigration: '',
          expectedMigration,
        });
      }
    }
    await input.database.prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, checksum TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    ).run();
    await ensureChecksumColumn(input.database);
    const manifestWithChecksums = await Promise.all(manifest.map(async (migration) => ({
      ...migration,
      checksum: await checksum(migration.sql),
    })));
    const applied = await input.database.prepare(
      'SELECT name, checksum FROM d1_migrations ORDER BY id',
    ).all<{ name: string; checksum: string | null }>();
    const expectedNames = manifestWithChecksums.map(({ name }) => name);
    const appliedNamesInOrder = applied.results.map(({ name }) => name);
    const currentMigration = appliedNamesInOrder.at(-1) ?? '';
    for (const [index, name] of appliedNamesInOrder.entries()) {
      if (name === expectedNames[index]) continue;
      throw new SchemaReadinessError({
        category: expectedNames.includes(name) ? 'migration_history_mismatch' : 'database_ahead',
        kind: input.kind,
        currentMigration,
        expectedMigration,
      });
    }
    const expectedChecksums = new Map(
      manifestWithChecksums.map((migration) => [migration.name, migration.checksum]),
    );
    for (const migration of applied.results) {
      const expected = expectedChecksums.get(migration.name);
      if (!expected) continue;
      if (migration.checksum && migration.checksum !== expected
        && !LEGACY_MIGRATION_CHECKSUMS.get(migration.name)?.has(migration.checksum)) {
        throw new SchemaReadinessError({
          category: 'checksum_mismatch',
          kind: input.kind,
          currentMigration,
          expectedMigration,
        });
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
        if (!raced) {
          throw new SchemaReadinessError({
            category: 'migration_apply_failed',
            kind: input.kind,
            currentMigration,
            expectedMigration,
            cause: error,
          });
        }
        if (raced.checksum && raced.checksum !== migration.checksum) {
          throw new SchemaReadinessError({
            category: 'checksum_mismatch',
            kind: input.kind,
            currentMigration: migration.name,
            expectedMigration,
          });
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
