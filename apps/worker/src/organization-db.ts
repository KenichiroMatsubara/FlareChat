import { cloudflareControlPlane } from './cloudflare';
import { and, isNotNull, ne } from 'drizzle-orm';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizationProvisionings, organizations } from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';

import organizationSchemaMigration from '../migrations/organization/0000_initial.sql';
import organizationTasksMigration from '../migrations/organization/0001_tasks.sql';
import type { Bindings } from './types';

const LOCAL_BINDING = /^LOCAL_ORGANIZATION_DB_\d+$/u;
const ORGANIZATION_MIGRATIONS = ['0000_initial.sql', '0001_tasks.sql'] as const;

const boundDatabase = (env: Bindings, bindingName: string): D1Database | null => {
  const bound = (env as unknown as Record<string, unknown>)[bindingName];
  if (!bound || typeof bound !== 'object') return null;
  return bound as D1Database;
};

const localBindings = (env: Bindings): string[] =>
  Object.keys(env as unknown as Record<string, unknown>)
    .filter((name) => LOCAL_BINDING.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

const migrationStatements = (): string[] =>
  [organizationSchemaMigration, organizationTasksMigration]
    .join('\n--> statement-breakpoint\n')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

const initializeDatabase = async (database: D1Database): Promise<void> => {
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const drops = tables.results
    .filter(({ name }) => !name.startsWith('sqlite_') && !name.startsWith('_cf_'))
    .map(({ name }) => `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
  const statements = [
    'PRAGMA defer_foreign_keys = on',
    ...drops,
    ...migrationStatements(),
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    ...ORGANIZATION_MIGRATIONS.map((name) => `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${name}')`),
    'PRAGMA defer_foreign_keys = off',
  ];
  await database.batch(statements.map((statement) => database.prepare(statement)));
};

const verifyDatabase = async (database: D1Database): Promise<void> => {
  try {
    await drizzleOrganizationDatabase(database).select({ id: googleConnections.id }).from(googleConnections).limit(1).all();
  } catch {
    throw new Error('Organization database schema verification failed.');
  }
};

export interface OrganizationDatabaseProvisioning {
  databaseId: string;
  bindingName: string;
  database: D1Database;
  /** Atomically resets and initializes this not-yet-active Organization database. */
  initialize: () => Promise<void>;
  finalize: () => Promise<void>;
}

interface ProvisionOrganizationDatabaseInput {
  organizationId: string;
  bindingName: string;
  databaseId: string | null;
}

const localDatabaseLocation = async (
  env: Bindings,
  input: ProvisionOrganizationDatabaseInput,
  bindings: string[],
): Promise<OrganizationDatabaseProvisioning> => {
  if (input.databaseId?.startsWith('local:')) {
    const database = boundDatabase(env, input.bindingName);
    if (!database) throw new Error(`Local Organization database binding ${input.bindingName} is unavailable.`);
    return {
      databaseId: input.databaseId,
      bindingName: input.bindingName,
      database,
      initialize: () => initializeDatabase(database),
      finalize: () => verifyDatabase(database),
    };
  }
  const control = controlDatabase(env.CONTROL_DB);
  const [activeBindings, provisioningBindings] = await Promise.all([
    control.select({ bindingName: organizations.bindingName }).from(organizations)
      .where(isNotNull(organizations.databaseId)).all(),
    control.select({ bindingName: organizationProvisionings.bindingName })
      .from(organizationProvisionings).where(and(
      isNotNull(organizationProvisionings.databaseId),
      ne(organizationProvisionings.organizationId, input.organizationId),
    )).all(),
  ]);
  const used = new Set([...activeBindings, ...provisioningBindings].map((row) => row.bindingName));
  const bindingName = bindings.find((name) => !used.has(name));
  if (!bindingName) throw new Error('No local Organization database slot is available. Reset an unused local Organization or add another local D1 binding.');
  const database = boundDatabase(env, bindingName);
  if (!database) throw new Error(`Local Organization database binding ${bindingName} is unavailable.`);
  return {
    databaseId: `local:${bindingName}`,
    bindingName,
    database,
    initialize: () => initializeDatabase(database),
    finalize: () => verifyDatabase(database),
  };
};

/**
 * Allocates one isolated Organization database. Local development uses a static
 * D1 binding pool; production creates and attaches a dedicated D1 database.
 */
export const provisionOrganizationDatabase = async (
  env: Bindings,
  input: ProvisionOrganizationDatabaseInput,
): Promise<OrganizationDatabaseProvisioning> => {
  const bindings = localBindings(env);
  if (bindings.length > 0) return localDatabaseLocation(env, input, bindings);
  const controlPlane = cloudflareControlPlane(env);
  const databaseId = input.databaseId ?? await controlPlane.createDatabase(`mail-organization-${input.organizationId}`);
  const database = controlPlane.openDatabase(databaseId);
  return {
    databaseId,
    bindingName: input.bindingName,
    database,
    initialize: () => initializeDatabase(database),
    finalize: async () => {
      await controlPlane.attachDatabase(input.bindingName, databaseId);
      await verifyDatabase(database);
    },
  };
};

/** Opens an Organization D1 only through its Worker binding. */
export const organizationDatabase = (env: Bindings, bindingName: string, _databaseId?: string | null): D1Database | null =>
  boundDatabase(env, bindingName);
