import { and, eq } from 'drizzle-orm';

import { createOrganizationKey, decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { fleetMigration } from './fleet-migration';
import { provisionOrganizationDatabase } from './organization-db';
import { controlDatabase, organizationDatabase } from './storage/database';
import { members, organizationKeys, organizationProvisionings, organizations } from './storage/control-schema';
import type { OrganizationProvisioningRecord } from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';
import type { Bindings } from './types';

type ProvisioningPhase = NonNullable<OrganizationProvisioningRecord['phase']>;

export class SchemaReleaseInProgressError extends Error {
  constructor() {
    super('Organization provisioning is paused during a schema release.');
    this.name = 'SchemaReleaseInProgressError';
  }
}

const requireProvisioningAllowed = async (env: Bindings): Promise<void> => {
  if (!await fleetMigration.provisioningAllowed(env)) {
    throw new SchemaReleaseInProgressError();
  }
};

const recordPhase = async (env: Bindings, organizationId: string, phase: ProvisioningPhase): Promise<void> => {
  await controlDatabase(env.CONTROL_DB).update(organizationProvisionings).set({
    phase,
    updatedAt: new Date().toISOString(),
  }).where(eq(organizationProvisionings.organizationId, organizationId)).run();
};

export const provisionOrganization = async (
  env: Bindings,
  provisioning: OrganizationProvisioningRecord,
): Promise<void> => {
  await requireProvisioningAllowed(env);
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  await recordPhase(env, provisioning.organizationId, 'allocating_database');
  const provisioned = await provisionOrganizationDatabase(env, {
    organizationId: provisioning.organizationId,
    inboxAddress: provisioning.inboxAddress,
    bindingName: provisioning.bindingName,
    databaseId: provisioning.databaseId,
  });
  const control = controlDatabase(env.CONTROL_DB);
  await control.update(organizationProvisionings).set({
    databaseId: provisioned.databaseId,
    bindingName: provisioned.bindingName,
    updatedAt: new Date().toISOString(),
  }).where(eq(organizationProvisionings.organizationId, provisioning.organizationId)).run();
  await recordPhase(env, provisioning.organizationId, 'applying_schema');
  await provisioned.initialize();
  const keyRecord = await control.select({
    masterKeyVersion: organizationKeys.masterKeyVersion,
    wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
  }).from(organizationKeys).where(eq(organizationKeys.organizationId, provisioning.organizationId)).get();
  if (!keyRecord) throw new Error('Organization encryption key is missing.');
  const organizationKey = await unwrapOrganizationKey({
    masterKeyVersion: keyRecord.masterKeyVersion,
    envelope: JSON.parse(keyRecord.wrappedKeyEnvelope),
  }, key, provisioning.organizationId);
  const tokenSet = await decrypt(
    JSON.parse(provisioning.credentialEnvelope),
    key,
    `automation-inbox-token:${provisioning.googleSubject}`,
  );
  const tokenEnvelope = await encrypt(
    tokenSet,
    organizationKey,
    `google-connection:${provisioning.organizationId}:automation-inbox`,
  );
  const timestamp = new Date().toISOString();
  await recordPhase(env, provisioning.organizationId, 'storing_credentials');
  await organizationDatabase(provisioned.database).insert(googleConnections).values({
    id: crypto.randomUUID(),
    kind: 'automation_inbox',
    googleSubject: provisioning.googleSubject,
    inboxAddress: provisioning.inboxAddress,
    grantedScopes: provisioning.grantedScopes,
    tokenEnvelope: JSON.stringify(tokenEnvelope),
    gmailHistoryId: provisioning.historyId,
    enabled: true,
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
      enabled: true,
      status: 'active',
      lastError: null,
      updatedAt: timestamp,
    },
  }).run();
  await recordPhase(env, provisioning.organizationId, 'verifying_binding');
  await provisioned.finalize();
  await requireProvisioningAllowed(env);
  await recordPhase(env, provisioning.organizationId, 'activating_organization');
  await control.batch([
    control.update(organizations).set({
      databaseId: provisioned.databaseId,
      bindingName: provisioned.bindingName,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(organizations.id, provisioning.organizationId)),
    control.update(members).set({ state: 'active', updatedAt: timestamp }).where(and(
      eq(members.organizationId, provisioning.organizationId),
      eq(members.identityId, provisioning.ownerIdentityId),
    )),
    control.delete(organizationProvisionings)
      .where(eq(organizationProvisionings.organizationId, provisioning.organizationId)),
  ]);
};

export const createProvisioningOrganizationKey = async (env: Bindings, organizationId: string): Promise<void> => {
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const wrapped = await createOrganizationKey(key, env.CREDENTIAL_MASTER_KEY_VERSION, organizationId);
  const timestamp = new Date().toISOString();
  await controlDatabase(env.CONTROL_DB).insert(organizationKeys).values({
    organizationId,
    masterKeyVersion: wrapped.masterKeyVersion,
    wrappedKeyEnvelope: JSON.stringify(wrapped.envelope),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoNothing().run();
};
