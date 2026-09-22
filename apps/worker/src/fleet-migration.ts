import { and, eq, isNotNull, or } from 'drizzle-orm';

import { cloudflareControlPlane } from './cloudflare';
import { createDatabaseAccess } from './database-access';
import { ORGANIZATION_SCHEMA_TARGET, schemaLifecycle } from './schema-lifecycle';
import { controlDatabase } from './storage/database';
import { accountProvisionings, accounts, schemaReleases } from './storage/control-schema';
import type { Bindings } from './types';

export interface FleetMigrationReceipt {
  targetMigration: string;
  migratedDatabases: number;
}

type FleetRow = {
  source: 'organizations' | 'organization_provisionings';
  accountId: string;
  bindingName: string | null | undefined;
  databaseId: string | null | undefined;
};

export interface FleetDatabase {
  accountId: string;
  bindingName: string;
  databaseId: string;
}

export const validateFleetRows = (rows: readonly FleetRow[]): FleetDatabase[] => {
  const fleet = new Map<string, FleetDatabase>();
  for (const row of rows) {
    if (typeof row.bindingName !== 'string' || row.bindingName.trim() === '') {
      throw new Error(
        `Invalid Account database route in ${row.source} for ${row.accountId}: binding_name is missing.`,
      );
    }
    if (typeof row.databaseId !== 'string' || row.databaseId.trim() === '') {
      throw new Error(
        `Invalid Account database route in ${row.source} for ${row.accountId}: database_id is missing.`,
      );
    }
    fleet.set(row.databaseId, {
      accountId: row.accountId,
      bindingName: row.bindingName,
      databaseId: row.databaseId,
    });
  }
  return [...fleet.values()];
};

const readFleet = async (env: Bindings): Promise<FleetDatabase[]> => {
  const control = controlDatabase(env.CONTROL_DB);
  const [activeOrSuspended, provisioning] = await Promise.all([
    control.select({
      accountId: accounts.id,
      bindingName: accounts.bindingName,
      databaseId: accounts.databaseId,
    }).from(accounts).where(isNotNull(accounts.databaseId)).all(),
    control.select({
      accountId: accountProvisionings.accountId,
      bindingName: accountProvisionings.bindingName,
      databaseId: accountProvisionings.databaseId,
    }).from(accountProvisionings)
      .where(isNotNull(accountProvisionings.databaseId)).all(),
  ]);
  return validateFleetRows([
    ...activeOrSuspended.map((row) => ({ ...row, source: 'organizations' as const })),
    ...provisioning.map((row) => ({ ...row, source: 'organization_provisionings' as const })),
  ]);
};

const migrateFleet = async (
  env: Bindings,
  fleet?: FleetDatabase[],
): Promise<FleetMigrationReceipt> => {
  const resolvedFleet = fleet ?? await readFleet(env);
  const databases = createDatabaseAccess(env);
  const remote = resolvedFleet.some(({ databaseId }) => !databaseId.startsWith('local:'))
    ? cloudflareControlPlane(env)
    : null;
  let targetMigration = ORGANIZATION_SCHEMA_TARGET;
  for (const account of resolvedFleet) {
    if (account.databaseId.startsWith('local:')) {
      const ready = await databases.open({
        kind: 'organization',
        bindingName: account.bindingName,
        databaseId: account.databaseId,
      });
      targetMigration = ready.schema.currentMigration;
    } else {
      const receipt = await schemaLifecycle.ensureCurrent({
        kind: 'organization',
        database: remote!.openDatabase(account.databaseId),
      });
      targetMigration = receipt.currentMigration;
    }
  }
  return {
    targetMigration,
    migratedDatabases: resolvedFleet.length,
  };
};

export const fleetMigration = {
  async prepareRelease(env: Bindings): Promise<FleetMigrationReceipt> {
    // Validate the Control-plane fleet before acquiring the release barrier.
    // A malformed route must not leave provisioning paused after a pre-release
    // inventory failure.
    const fleet = await readFleet(env);
    const control = controlDatabase(env.CONTROL_DB);
    const acquired = await control.update(schemaReleases).set({
      state: 'migrating',
      targetMigration: ORGANIZATION_SCHEMA_TARGET,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(schemaReleases.id, 'organization'),
      or(
        eq(schemaReleases.state, 'ready'),
        and(
          eq(schemaReleases.state, 'migrating'),
          eq(schemaReleases.targetMigration, ORGANIZATION_SCHEMA_TARGET),
        ),
      ),
    )).run();
    if (acquired.meta.changes === 0) {
      throw new Error('Another schema release is already in progress.');
    }
    return migrateFleet(env, fleet);
  },

  async completeRelease(env: Bindings): Promise<FleetMigrationReceipt> {
    const receipt = await migrateFleet(env);
    const completed = await controlDatabase(env.CONTROL_DB).update(schemaReleases).set({
      state: 'ready',
      targetMigration: ORGANIZATION_SCHEMA_TARGET,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(schemaReleases.id, 'organization'),
      eq(schemaReleases.state, 'migrating'),
      eq(schemaReleases.targetMigration, ORGANIZATION_SCHEMA_TARGET),
    )).run();
    if (completed.meta.changes === 0) {
      throw new Error('The prepared schema release no longer owns the release barrier.');
    }
    return receipt;
  },

  async provisioningAllowed(env: Bindings): Promise<boolean> {
    const release = await controlDatabase(env.CONTROL_DB).select({
      state: schemaReleases.state,
    }).from(schemaReleases).where(eq(schemaReleases.id, 'organization')).get();
    return release?.state === 'ready';
  },
};
