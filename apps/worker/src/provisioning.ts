import { and, eq, sql } from 'drizzle-orm';

import organizationSchemaMigration from '../migrations/organization/0000_initial.sql';
import { createOrganizationKey, decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { provisionOrganizationDatabase } from './organization-db';
import { controlDatabase, organizationDatabase } from './storage/database';
import { members, organizationKeys, organizations, organizationSetups } from './storage/control-schema';
import type { OrganizationSetupRecord } from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';
import type { Bindings } from './types';

type ProvisioningPhase = NonNullable<OrganizationSetupRecord['provisioningPhase']>;

const recordPhase = async (env: Bindings, setupId: string, phase: ProvisioningPhase): Promise<void> => {
  await controlDatabase(env.CONTROL_DB).update(organizationSetups).set({
    provisioningPhase: phase,
    updatedAt: new Date().toISOString(),
  }).where(eq(organizationSetups.id, setupId)).run();
};

const applyOrganizationSchema = async (binding: D1Database): Promise<void> => {
  const database = organizationDatabase(binding);
  const statements = organizationSchemaMigration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await database.run(sql.raw(statement));
};

export const provisionSetup = async (env: Bindings, setup: OrganizationSetupRecord): Promise<void> => {
  if (!setup.organizationId || !setup.ownerIdentityId || !setup.inboxAddress || !setup.googleSubject || !setup.grantedScopes || !setup.credentialEnvelope || !setup.historyId || !setup.bindingName) {
    throw new Error('Organization setup is incomplete.');
  }
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  await recordPhase(env, setup.id, 'allocating_database');
  const provisioned = await provisionOrganizationDatabase(env, {
    organizationId: setup.organizationId,
    setupId: setup.id,
    bindingName: setup.bindingName,
    databaseId: setup.databaseId,
  });
  const control = controlDatabase(env.CONTROL_DB);
  await control.update(organizationSetups).set({
    databaseId: provisioned.databaseId,
    bindingName: provisioned.bindingName,
    updatedAt: new Date().toISOString(),
  }).where(eq(organizationSetups.id, setup.id)).run();
  await recordPhase(env, setup.id, 'applying_schema');
  await applyOrganizationSchema(provisioned.database);
  const keyRecord = await control.select({
    masterKeyVersion: organizationKeys.masterKeyVersion,
    wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
  }).from(organizationKeys).where(eq(organizationKeys.organizationId, setup.organizationId)).get();
  if (!keyRecord) throw new Error('Organization encryption key is missing.');
  const organizationKey = await unwrapOrganizationKey({
    masterKeyVersion: keyRecord.masterKeyVersion,
    envelope: JSON.parse(keyRecord.wrappedKeyEnvelope),
  }, key, setup.organizationId);
  const tokenSet = await decrypt(JSON.parse(setup.credentialEnvelope), key, `setup-credential:${setup.id}`);
  const tokenEnvelope = await encrypt(tokenSet, organizationKey, `google-connection:${setup.organizationId}:automation-inbox`);
  const timestamp = new Date().toISOString();
  await recordPhase(env, setup.id, 'storing_credentials');
  await organizationDatabase(provisioned.database).insert(googleConnections).values({
    id: crypto.randomUUID(),
    kind: 'automation_inbox',
    googleSubject: setup.googleSubject,
    inboxAddress: setup.inboxAddress,
    grantedScopes: setup.grantedScopes,
    tokenEnvelope: JSON.stringify(tokenEnvelope),
    gmailHistoryId: setup.historyId,
    enabled: true,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoNothing().run();
  await recordPhase(env, setup.id, 'verifying_binding');
  await provisioned.finalize();
  await recordPhase(env, setup.id, 'activating_organization');
  await control.batch([
    control.update(organizations).set({
      databaseId: provisioned.databaseId,
      bindingName: provisioned.bindingName,
      status: 'active',
      updatedAt: timestamp,
    }).where(eq(organizations.id, setup.organizationId)),
    control.update(members).set({ state: 'active', updatedAt: timestamp }).where(and(
      eq(members.organizationId, setup.organizationId),
      eq(members.identityId, setup.ownerIdentityId),
    )),
    control.update(organizationSetups).set({
      state: 'active',
      databaseId: provisioned.databaseId,
      bindingName: provisioned.bindingName,
      credentialEnvelope: null,
      provisioningPhase: null,
      errorMessage: null,
      updatedAt: timestamp,
    }).where(eq(organizationSetups.id, setup.id)),
  ]);
};

export const createSetupOrganizationKey = async (env: Bindings, organizationId: string): Promise<void> => {
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
