import { and, eq } from 'drizzle-orm';

import { ensureBaselineSchemaRule } from './baseline-automation';
import { createAccountKey, decrypt, encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { fleetMigration } from './fleet-migration';
import { provisionAccountDatabase } from './account-db';
import { applyPreset } from './presets';
import { controlDatabase, accountDatabase } from './storage/database';
import { accountIdentities, accountKeys, accountProvisionings, accounts } from './storage/control-schema';
import type { AccountProvisioningRecord } from './storage/control-schema';
import { googleConnections } from './storage/account-schema';
import type { Bindings } from './types';

type ProvisioningPhase = NonNullable<AccountProvisioningRecord['phase']>;

export class SchemaReleaseInProgressError extends Error {
  constructor() {
    super('Account provisioning is paused during a schema release.');
    this.name = 'SchemaReleaseInProgressError';
  }
}

const requireProvisioningAllowed = async (env: Bindings): Promise<void> => {
  if (!await fleetMigration.provisioningAllowed(env)) {
    throw new SchemaReleaseInProgressError();
  }
};

const recordPhase = async (env: Bindings, accountId: string, phase: ProvisioningPhase): Promise<void> => {
  await controlDatabase(env.CONTROL_DB).update(accountProvisionings).set({
    phase,
    updatedAt: new Date().toISOString(),
  }).where(eq(accountProvisionings.accountId, accountId)).run();
};

export const provisionAccount = async (
  env: Bindings,
  provisioning: AccountProvisioningRecord,
): Promise<void> => {
  await requireProvisioningAllowed(env);
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  await recordPhase(env, provisioning.accountId, 'allocating_database');
  const provisioned = await provisionAccountDatabase(env, {
    accountId: provisioning.accountId,
    inboxAddress: provisioning.inboxAddress,
    bindingName: provisioning.bindingName,
    databaseId: provisioning.databaseId,
  });
  const control = controlDatabase(env.CONTROL_DB);
  await control.update(accountProvisionings).set({
    databaseId: provisioned.databaseId,
    bindingName: provisioned.bindingName,
    updatedAt: new Date().toISOString(),
  }).where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  await recordPhase(env, provisioning.accountId, 'applying_schema');
  await provisioned.initialize();
  const account = accountDatabase(provisioned.database);
  if (provisioning.presetId) {
    await applyPreset(account, provisioning.accountId, provisioning.presetId, {
      applicationKey: provisioning.provisioningKey,
    });
  }
  await ensureBaselineSchemaRule(account, provisioning.accountId);
  const keyRecord = await control.select({
    masterKeyVersion: accountKeys.masterKeyVersion,
    wrappedKeyEnvelope: accountKeys.wrappedKeyEnvelope,
  }).from(accountKeys).where(eq(accountKeys.accountId, provisioning.accountId)).get();
  if (!keyRecord) throw new Error('Account encryption key is missing.');
  const accountKey = await unwrapAccountKey({
    masterKeyVersion: keyRecord.masterKeyVersion,
    envelope: JSON.parse(keyRecord.wrappedKeyEnvelope),
  }, key, provisioning.accountId);
  const tokenSet = await decrypt(
    JSON.parse(provisioning.credentialEnvelope),
    key,
    `automation-inbox-token:${provisioning.googleSubject}`,
  );
  const tokenEnvelope = await encrypt(
    tokenSet,
    accountKey,
    `google-connection:${provisioning.accountId}:automation-inbox`,
  );
  const timestamp = new Date().toISOString();
  await recordPhase(env, provisioning.accountId, 'storing_credentials');
  await account.insert(googleConnections).values({
    id: crypto.randomUUID(),
    kind: 'automation_inbox',
    googleSubject: provisioning.googleSubject,
    inboxAddress: provisioning.inboxAddress,
    grantedScopes: provisioning.grantedScopes,
    tokenEnvelope: JSON.stringify(tokenEnvelope),
    gmailHistoryId: provisioning.historyId,
    enabled: false,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: googleConnections.googleSubject,
    set: {
      inboxAddress: provisioning.inboxAddress,
      grantedScopes: provisioning.grantedScopes,
      tokenEnvelope: JSON.stringify(tokenEnvelope),
      gmailHistoryId: provisioning.historyId,
      enabled: false,
      status: 'active',
      lastError: null,
      updatedAt: timestamp,
    },
  }).run();
  await recordPhase(env, provisioning.accountId, 'verifying_binding');
  await provisioned.finalize();
  await requireProvisioningAllowed(env);
  await recordPhase(env, provisioning.accountId, 'activating_organization');
  await control.batch([
    control.update(accounts).set({
      databaseId: provisioned.databaseId,
      bindingName: provisioned.bindingName,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(accounts.id, provisioning.accountId)),
    control.update(accountIdentities).set({ state: 'active', updatedAt: timestamp }).where(and(
      eq(accountIdentities.accountId, provisioning.accountId),
      eq(accountIdentities.identityId, provisioning.ownerIdentityId),
    )),
    control.delete(accountProvisionings)
      .where(eq(accountProvisionings.accountId, provisioning.accountId)),
  ]);
};

export const createProvisioningAccountKey = async (env: Bindings, accountId: string): Promise<void> => {
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const wrapped = await createAccountKey(key, env.CREDENTIAL_MASTER_KEY_VERSION, accountId);
  const timestamp = new Date().toISOString();
  await controlDatabase(env.CONTROL_DB).insert(accountKeys).values({
    accountId,
    masterKeyVersion: wrapped.masterKeyVersion,
    wrappedKeyEnvelope: JSON.stringify(wrapped.envelope),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoNothing().run();
};
