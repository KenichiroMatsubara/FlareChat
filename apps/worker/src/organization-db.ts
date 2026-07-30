import { cloudflareControlPlane } from './cloudflare';
import { and, isNotNull, ne } from 'drizzle-orm';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizationProvisionings, organizations } from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';
import { schemaLifecycle } from './schema-lifecycle';

import type { Bindings } from './types';

const LOCAL_BINDING = /^LOCAL_ORGANIZATION_DB_\d+$/u;
const DATABASE_NAME_PREFIX = 'flarechat-organization-';
const DATABASE_NAME_HASH_LENGTH = 12;
const BINDING_HASH_LENGTH = 24;
const MAX_DATABASE_NAME_LENGTH = 96;

const boundDatabase = (env: Bindings, bindingName: string): D1Database | null => {
  const bound = (env as unknown as Record<string, unknown>)[bindingName];
  if (!bound || typeof bound !== 'object') return null;
  return bound as D1Database;
};

const localBindings = (env: Bindings): string[] =>
  Object.keys(env as unknown as Record<string, unknown>)
    .filter((name) => LOCAL_BINDING.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

const initializeDatabase = async (database: D1Database): Promise<void> => {
  await schemaLifecycle.ensureCurrent({ kind: 'organization', database });
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
  inboxAddress: string;
  bindingName: string;
  databaseId: string | null;
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const organizationDatabaseIdentity = async (
  inboxAddress: string,
): Promise<{ databaseName: string; bindingName: string }> => {
  const normalized = inboxAddress.trim().normalize('NFKC').toLowerCase();
  if (!normalized) throw new Error('Automation Inbox address is required for database provisioning.');
  const hash = await sha256(normalized);
  const readable = normalized
    .replace('@', '-at-')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'inbox';
  const suffix = `-${hash.slice(0, DATABASE_NAME_HASH_LENGTH)}`;
  const readableLimit = MAX_DATABASE_NAME_LENGTH - DATABASE_NAME_PREFIX.length - suffix.length;
  const databaseName = `${DATABASE_NAME_PREFIX}${readable.slice(0, readableLimit).replace(/-+$/gu, '')}${suffix}`;
  return {
    databaseName,
    bindingName: `ORG_${hash.slice(0, BINDING_HASH_LENGTH).toUpperCase()}`,
  };
};

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
  const identity = await organizationDatabaseIdentity(input.inboxAddress);
  const databaseId = input.databaseId ?? await controlPlane.ensureDatabase(identity.databaseName);
  const database = controlPlane.openDatabase(databaseId);
  return {
    databaseId,
    bindingName: identity.bindingName,
    database,
    initialize: () => initializeDatabase(database),
    finalize: async () => {
      await controlPlane.attachDatabase(identity.bindingName, databaseId);
      await verifyDatabase(database);
    },
  };
};
