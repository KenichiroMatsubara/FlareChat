import { attachD1Binding, createD1Database, queryD1, verifyD1Schema } from './cloudflare';
import { and, isNotNull, ne } from 'drizzle-orm';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizations, organizationSetups } from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';

import type { Bindings } from './types';

const LOCAL_BINDING = /^LOCAL_ORGANIZATION_DB_\d+$/u;

const remoteStatement = (env: Bindings, databaseId: string, sql: string, params: unknown[] = []): D1PreparedStatement => {
  const execute = async (): Promise<{ results: unknown[]; meta: Record<string, number | boolean | string | null> }> => {
    const result = await queryD1<unknown>(env, databaseId, sql, params);
    return { results: result.results ?? [], meta: result.meta ?? {} };
  };
  return {
    bind: (...values: unknown[]) => remoteStatement(env, databaseId, sql, values),
    first: async <T>(column?: string): Promise<T | null> => {
      const row = (await execute()).results[0];
      if (!row || typeof row !== 'object') return null;
      return (column ? (row as Record<string, T>)[column] : row) as T;
    },
    all: async <T>(): Promise<D1Result<T>> => {
      const result = await execute();
      return { success: true, results: result.results as T[], meta: result.meta as D1Result<T>['meta'] };
    },
    run: async <T>(): Promise<D1Result<T>> => {
      const result = await execute();
      return { success: true, results: result.results as T[], meta: result.meta as D1Result<T>['meta'] };
    },
    raw: async <T>(): Promise<T[][]> => (await execute()).results as T[][],
  } as unknown as D1PreparedStatement;
};

const remoteDatabase = (env: Bindings, databaseId: string): D1Database => ({
  prepare: (sql: string) => remoteStatement(env, databaseId, sql),
} as unknown as D1Database);

const boundDatabase = (env: Bindings, bindingName: string): D1Database | null => {
  const bound = (env as unknown as Record<string, unknown>)[bindingName];
  if (!bound || typeof bound !== 'object') return null;
  return bound as D1Database;
};

const localBindings = (env: Bindings): string[] =>
  Object.keys(env as unknown as Record<string, unknown>)
    .filter((name) => LOCAL_BINDING.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

const resetLocalDatabase = async (database: D1Database): Promise<void> => {
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  for (const { name } of tables.results.reverse()) {
    if (name.startsWith('sqlite_') || name.startsWith('_cf_')) continue;
    await database.prepare(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`).run();
  }
};

const verifyLocalDatabase = async (database: D1Database): Promise<void> => {
  try {
    await drizzleOrganizationDatabase(database).select({ id: googleConnections.id }).from(googleConnections).limit(1).all();
  } catch {
    throw new Error('Local Organization database schema verification failed.');
  }
};

export interface OrganizationDatabaseProvisioning {
  databaseId: string;
  bindingName: string;
  database: D1Database;
  finalize: () => Promise<void>;
}

interface ProvisionOrganizationDatabaseInput {
  organizationId: string;
  setupId: string;
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
      finalize: () => verifyLocalDatabase(database),
    };
  }
  const control = controlDatabase(env.CONTROL_DB);
  const [activeBindings, setupBindings] = await Promise.all([
    control.select({ bindingName: organizations.bindingName }).from(organizations)
      .where(isNotNull(organizations.databaseId)).all(),
    control.select({ bindingName: organizationSetups.bindingName }).from(organizationSetups).where(and(
      isNotNull(organizationSetups.databaseId),
      ne(organizationSetups.state, 'expired'),
      ne(organizationSetups.id, input.setupId),
    )).all(),
  ]);
  const used = new Set([...activeBindings, ...setupBindings].flatMap((row) => row.bindingName ? [row.bindingName] : []));
  const bindingName = bindings.find((name) => !used.has(name));
  if (!bindingName) throw new Error('No local Organization database slot is available. Reset an unused local Organization or add another local D1 binding.');
  const database = boundDatabase(env, bindingName);
  if (!database) throw new Error(`Local Organization database binding ${bindingName} is unavailable.`);
  await resetLocalDatabase(database);
  return {
    databaseId: `local:${bindingName}`,
    bindingName,
    database,
    finalize: () => verifyLocalDatabase(database),
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
  const databaseId = input.databaseId ?? await createD1Database(env, `mail-organization-${input.organizationId}`);
  return {
    databaseId,
    bindingName: input.bindingName,
    database: remoteDatabase(env, databaseId),
    finalize: async () => {
      await attachD1Binding(env, input.bindingName, databaseId);
      await verifyD1Schema(env, databaseId);
    },
  };
};

/** Opens an Organization D1 only through its Worker binding. */
export const organizationDatabase = (env: Bindings, bindingName: string, _databaseId?: string | null): D1Database | null =>
  boundDatabase(env, bindingName);
