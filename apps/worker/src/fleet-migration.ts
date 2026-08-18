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

const migrateFleet = async (env: Bindings): Promise<FleetMigrationReceipt> => {
  const control = controlDatabase(env.CONTROL_DB);
  const [activeOrSuspended, provisioning] = await Promise.all([
    control.select({
      bindingName: accounts.bindingName,
      databaseId: accounts.databaseId,
    }).from(accounts).where(isNotNull(accounts.databaseId)).all(),
    control.select({
      bindingName: accountProvisionings.bindingName,
      databaseId: accountProvisionings.databaseId,
    }).from(accountProvisionings)
      .where(isNotNull(accountProvisionings.databaseId)).all(),
  ]);
  const fleet = [...new Map(
    [...activeOrSuspended, ...provisioning]
      .filter((database): database is { bindingName: string; databaseId: string } =>
        database.databaseId !== null)
      .map((database) => [database.databaseId, database]),
  ).values()];
  const databases = createDatabaseAccess(env);
  const remote = fleet.some(({ databaseId }) => !databaseId.startsWith('local:'))
    ? cloudflareControlPlane(env)
    : null;
  let targetMigration = ORGANIZATION_SCHEMA_TARGET;
  for (const account of fleet) {
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
    migratedDatabases: fleet.length,
  };
};

export const fleetMigration = {
  async prepareRelease(env: Bindings): Promise<FleetMigrationReceipt> {
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
    return migrateFleet(env);
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
