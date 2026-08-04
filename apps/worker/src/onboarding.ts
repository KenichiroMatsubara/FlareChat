import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { AppState } from '@mail/domain';

import { createAutomation } from './automation';
import { decrypt, masterKey } from './cryptography';
import { createDatabaseAccess } from './database-access';
import { revokeGoogleToken } from './google';
import { organizationDatabaseIdentity } from './organization-db';
import {
  createProvisioningOrganizationKey,
  provisionOrganization,
  SchemaReleaseInProgressError,
} from './provisioning';
import { availablePresets } from './presets';
import { controlDatabase } from './storage/database';
import {
  admins,
  automationInboxClaims,
  organizationProvisionings,
  organizations,
  organizationSetups,
} from './storage/control-schema';
import type { OrganizationProvisioningRecord, OrganizationSetupRecord } from './storage/control-schema';
import type { Bindings, SessionRow } from './types';

const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const provisioningByOrganizationId = (
  env: Bindings,
  organizationId: string,
): Promise<OrganizationProvisioningRecord | undefined> =>
  controlDatabase(env.CONTROL_DB).select().from(organizationProvisionings)
    .where(eq(organizationProvisionings.organizationId, organizationId)).get();

const revokeCredential = async (
  env: Bindings,
  credentialEnvelope: string,
  googleSubject: string,
): Promise<void> => {
  try {
    const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
    const tokens = JSON.parse(await decrypt(
      JSON.parse(credentialEnvelope),
      key,
      `automation-inbox-token:${googleSubject}`,
    )) as { refreshToken?: string };
    if (tokens.refreshToken) await revokeGoogleToken(tokens.refreshToken);
  } catch {
    // Local state must still be erased when Google revocation is unavailable.
  }
};

const discardSetup = async (env: Bindings, setup: OrganizationSetupRecord): Promise<void> => {
  await revokeCredential(env, setup.credentialEnvelope, setup.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.setupId, setup.id)),
    control.delete(organizationSetups).where(eq(organizationSetups.id, setup.id)),
  ]);
};

const discardProvisioning = async (
  env: Bindings,
  provisioning: OrganizationProvisioningRecord,
): Promise<void> => {
  await revokeCredential(env, provisioning.credentialEnvelope, provisioning.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.organizationId, provisioning.organizationId)),
    control.delete(organizations).where(eq(organizations.id, provisioning.organizationId)),
  ]);
};

const attemptProvision = async (env: Bindings, provisioning: OrganizationProvisioningRecord): Promise<void> => {
  try {
    await createProvisioningOrganizationKey(env, provisioning.organizationId);
    await provisionOrganization(env, provisioning);
  } catch (error) {
    if (error instanceof SchemaReleaseInProgressError) return;
    await controlDatabase(env.CONTROL_DB).update(organizationProvisionings).set({
      state: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Provisioning failed.',
      updatedAt: now(),
    }).where(eq(organizationProvisionings.organizationId, provisioning.organizationId)).run();
  }
};

const beginProvisioning = async (
  env: Bindings,
  setup: OrganizationSetupRecord,
  name: string,
  presetId?: string,
): Promise<void> => {
  const organizationId = crypto.randomUUID();
  const { bindingName } = await organizationDatabaseIdentity(setup.inboxAddress);
  const createdAt = now();
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.insert(organizations).values({
      id: organizationId,
      name,
      status: 'provisioning',
      bindingName,
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(admins).values({
      organizationId,
      identityId: setup.ownerIdentityId,
      state: 'active',
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(organizationProvisionings).values({
      organizationId,
      ownerIdentityId: setup.ownerIdentityId,
      state: 'provisioning',
      inboxAddress: setup.inboxAddress,
      googleSubject: setup.googleSubject,
      grantedScopes: setup.grantedScopes,
      credentialEnvelope: setup.credentialEnvelope,
      historyId: setup.historyId,
      bindingName,
      provisioningKey: crypto.randomUUID(),
      presetId: presetId ?? null,
      expiresAt: expiresIn(PROVISIONING_WINDOW_MS),
      createdAt,
      updatedAt: createdAt,
    }),
    control.update(automationInboxClaims).set({
      setupId: null,
      organizationId,
      updatedAt: createdAt,
    }).where(eq(automationInboxClaims.setupId, setup.id)),
    control.delete(organizationSetups).where(eq(organizationSetups.id, setup.id)),
  ]);
  await createProvisioningOrganizationKey(env, organizationId);
  const current = await provisioningByOrganizationId(env, organizationId);
  if (current) await attemptProvision(env, current);
};

export const confirmOrganization = async (
  env: Bindings,
  ownerIdentityId: string,
  requestedName: string,
  presetId?: string,
): Promise<void> => {
  const setup = await controlDatabase(env.CONTROL_DB).select().from(organizationSetups)
    .where(eq(organizationSetups.ownerIdentityId, ownerIdentityId)).get();
  if (!setup) throw new Error('Organization setup is not waiting for name confirmation.');
  if (Date.parse(setup.expiresAt) <= Date.now()) {
    await discardSetup(env, setup);
    throw new Error('Organization setup expired. Start over with Google authorization.');
  }
  const name = requestedName.trim() || setup.name;
  if (!name) throw new Error('Organization name is required.');
  if (presetId && !availablePresets().some((preset) => preset.id === presetId)) throw new Error('Preset was not found.');
  await beginProvisioning(env, setup, name, presetId);
};

export const retryOrganizationProvisioning = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<void> => {
  const provisioning = await controlDatabase(env.CONTROL_DB).select().from(organizationProvisionings)
    .where(and(
      eq(organizationProvisionings.ownerIdentityId, ownerIdentityId),
      eq(organizationProvisionings.state, 'failed'),
    )).get();
  if (!provisioning) throw new Error('Organization provisioning is not waiting for retry.');
  if (Date.parse(provisioning.expiresAt) <= Date.now()) {
    await discardProvisioning(env, provisioning);
    throw new Error('Organization setup expired. Start over with Google authorization.');
  }
  await controlDatabase(env.CONTROL_DB).update(organizationProvisionings)
    .set({ state: 'provisioning', errorMessage: null, updatedAt: now() })
    .where(eq(organizationProvisionings.organizationId, provisioning.organizationId)).run();
  const ready = await provisioningByOrganizationId(env, provisioning.organizationId);
  if (!ready) throw new Error('Organization provisioning could not be retried.');
  await attemptProvision(env, ready);
};

export const cancelOrganizationOnboarding = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<boolean> => {
  const control = controlDatabase(env.CONTROL_DB);
  const setup = await control.select().from(organizationSetups)
    .where(eq(organizationSetups.ownerIdentityId, ownerIdentityId)).get();
  if (setup) await discardSetup(env, setup);
  const provisioning = await control.select().from(organizationProvisionings)
    .where(eq(organizationProvisionings.ownerIdentityId, ownerIdentityId)).get();
  if (provisioning) await discardProvisioning(env, provisioning);
  return Boolean(setup || provisioning);
};

export const applicationState = async (env: Bindings, session: SessionRow): Promise<AppState> => {
  const identity = { email: session.email, displayName: session.display_name };
  const control = controlDatabase(env.CONTROL_DB);
  const memberships = await control.select({
    organizationId: admins.organizationId,
    name: organizations.name,
    status: organizations.status,
    databaseId: organizations.databaseId,
    bindingName: organizations.bindingName,
  }).from(admins).innerJoin(organizations, eq(organizations.id, admins.organizationId))
    .where(and(
      eq(admins.identityId, session.identity_id),
      eq(admins.state, 'active'),
      isNotNull(organizations.databaseId),
    )).all();
  if (memberships.length > 0) {
    const databases = createDatabaseAccess(env);
    await Promise.all(memberships.map(async (membership) => {
      const database = await databases.open({
        kind: 'organization',
        bindingName: membership.bindingName,
        databaseId: membership.databaseId,
      });
      await createAutomation(env).verifyOrganizationInboxCredential({
        organizationId: membership.organizationId,
        database: database.raw,
      });
    }));
    return {
      kind: 'ready',
      identity,
      organizations: memberships.map(({ organizationId, name, status }) => ({ organizationId, name, status })),
    };
  }
  const setup = await control.select().from(organizationSetups)
    .where(eq(organizationSetups.ownerIdentityId, session.identity_id)).get();
  if (setup) {
    if (Date.parse(setup.expiresAt) <= Date.now()) {
      await discardSetup(env, setup);
      return { kind: 'unassigned', identity };
    }
    return {
      kind: 'confirming_organization',
      identity,
      setup: {
        id: setup.id,
        name: setup.name,
        inboxAddress: setup.inboxAddress,
        expiresAt: setup.expiresAt,
      },
    };
  }
  const provisioning = await control.select({
    organizationId: organizationProvisionings.organizationId,
    name: organizations.name,
    state: organizationProvisionings.state,
    phase: organizationProvisionings.phase,
    errorMessage: organizationProvisionings.errorMessage,
    expiresAt: organizationProvisionings.expiresAt,
  }).from(organizationProvisionings)
    .innerJoin(organizations, eq(organizations.id, organizationProvisionings.organizationId))
    .where(eq(organizationProvisionings.ownerIdentityId, session.identity_id)).get();
  if (provisioning?.state === 'failed') {
    return {
      kind: 'provisioning_failed',
      identity,
      organization: { id: provisioning.organizationId, name: provisioning.name },
      phase: provisioning.phase,
      error: provisioning.errorMessage,
      retryUntil: provisioning.expiresAt,
    };
  }
  if (provisioning) {
    return {
      kind: 'provisioning',
      identity,
      organization: { id: provisioning.organizationId, name: provisioning.name },
      phase: provisioning.phase,
    };
  }
  return { kind: 'unassigned', identity };
};

export const retryProvisioning = async (env: Bindings): Promise<void> => {
  const rows = await controlDatabase(env.CONTROL_DB).select().from(organizationProvisionings)
    .where(inArray(organizationProvisionings.state, ['provisioning', 'failed']))
    .orderBy(asc(organizationProvisionings.updatedAt)).limit(10).all();
  for (const provisioning of rows) {
    if (Date.parse(provisioning.expiresAt) <= Date.now()) {
      await discardProvisioning(env, provisioning);
      continue;
    }
    await attemptProvision(env, provisioning);
  }
};
