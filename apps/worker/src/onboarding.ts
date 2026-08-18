import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { AppState } from '@mail/domain';

import { createAutomation } from './automation';
import { decrypt, masterKey } from './cryptography';
import { createDatabaseAccess } from './database-access';
import { revokeGoogleToken } from './google';
import { accountDatabaseIdentity } from './account-db';
import {
  createProvisioningAccountKey,
  provisionAccount,
  SchemaReleaseInProgressError,
} from './provisioning';
import { availablePresets } from './presets';
import { controlDatabase } from './storage/database';
import {
  accountIdentities,
  automationInboxClaims,
  identities,
  contactLogins,
  accountProvisionings,
  accounts,
  accountSetups,
} from './storage/control-schema';
import type { AccountProvisioningRecord, AccountSetupRecord } from './storage/control-schema';
import type { Bindings, SessionRow } from './types';

const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const provisioningByAccountId = (
  env: Bindings,
  accountId: string,
): Promise<AccountProvisioningRecord | undefined> =>
  controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(eq(accountProvisionings.accountId, accountId)).get();

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

const discardSetup = async (env: Bindings, setup: AccountSetupRecord): Promise<void> => {
  await revokeCredential(env, setup.credentialEnvelope, setup.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.setupId, setup.id)),
    control.delete(accountSetups).where(eq(accountSetups.id, setup.id)),
  ]);
};

const discardProvisioning = async (
  env: Bindings,
  provisioning: AccountProvisioningRecord,
): Promise<void> => {
  await revokeCredential(env, provisioning.credentialEnvelope, provisioning.googleSubject);
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.delete(automationInboxClaims).where(eq(automationInboxClaims.accountId, provisioning.accountId)),
    control.delete(accounts).where(eq(accounts.id, provisioning.accountId)),
  ]);
};

const attemptProvision = async (env: Bindings, provisioning: AccountProvisioningRecord): Promise<void> => {
  try {
    await createProvisioningAccountKey(env, provisioning.accountId);
    await provisionAccount(env, provisioning);
  } catch (error) {
    if (error instanceof SchemaReleaseInProgressError) return;
    await controlDatabase(env.CONTROL_DB).update(accountProvisionings).set({
      state: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Provisioning failed.',
      updatedAt: now(),
    }).where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  }
};

const beginProvisioning = async (
  env: Bindings,
  setup: AccountSetupRecord,
  name: string,
  presetId?: string,
): Promise<void> => {
  const accountId = crypto.randomUUID();
  const { bindingName } = await accountDatabaseIdentity(setup.inboxAddress);
  const createdAt = now();
  const control = controlDatabase(env.CONTROL_DB);
  await control.batch([
    control.insert(accounts).values({
      id: accountId,
      name,
      status: 'provisioning',
      bindingName,
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(accountIdentities).values({
      accountId,
      identityId: setup.ownerIdentityId,
      state: 'active',
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(accountProvisionings).values({
      accountId,
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
      accountId,
      updatedAt: createdAt,
    }).where(eq(automationInboxClaims.setupId, setup.id)),
    control.delete(accountSetups).where(eq(accountSetups.id, setup.id)),
  ]);
  await createProvisioningAccountKey(env, accountId);
  const current = await provisioningByAccountId(env, accountId);
  if (current) await attemptProvision(env, current);
};

export const confirmAccount = async (
  env: Bindings,
  ownerIdentityId: string,
  requestedName: string,
  presetId?: string,
): Promise<void> => {
  const setup = await controlDatabase(env.CONTROL_DB).select().from(accountSetups)
    .where(eq(accountSetups.ownerIdentityId, ownerIdentityId)).get();
  if (!setup) throw new Error('Account setup is not waiting for name confirmation.');
  if (Date.parse(setup.expiresAt) <= Date.now()) {
    await discardSetup(env, setup);
    throw new Error('Account setup expired. Start over with Google authorization.');
  }
  const name = requestedName.trim() || setup.name;
  if (!name) throw new Error('Account name is required.');
  if (presetId && !availablePresets().some((preset) => preset.id === presetId)) throw new Error('Preset was not found.');
  await beginProvisioning(env, setup, name, presetId);
};

export const retryAccountProvisioning = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<void> => {
  const provisioning = await controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(and(
      eq(accountProvisionings.ownerIdentityId, ownerIdentityId),
      eq(accountProvisionings.state, 'failed'),
    )).get();
  if (!provisioning) throw new Error('Account provisioning is not waiting for retry.');
  if (Date.parse(provisioning.expiresAt) <= Date.now()) {
    await discardProvisioning(env, provisioning);
    throw new Error('Account setup expired. Start over with Google authorization.');
  }
  await controlDatabase(env.CONTROL_DB).update(accountProvisionings)
    .set({ state: 'provisioning', errorMessage: null, updatedAt: now() })
    .where(eq(accountProvisionings.accountId, provisioning.accountId)).run();
  const ready = await provisioningByAccountId(env, provisioning.accountId);
  if (!ready) throw new Error('Account provisioning could not be retried.');
  await attemptProvision(env, ready);
};

export const cancelAccountOnboarding = async (
  env: Bindings,
  ownerIdentityId: string,
): Promise<boolean> => {
  const control = controlDatabase(env.CONTROL_DB);
  const setup = await control.select().from(accountSetups)
    .where(eq(accountSetups.ownerIdentityId, ownerIdentityId)).get();
  if (setup) await discardSetup(env, setup);
  const provisioning = await control.select().from(accountProvisionings)
    .where(eq(accountProvisionings.ownerIdentityId, ownerIdentityId)).get();
  if (provisioning) await discardProvisioning(env, provisioning);
  return Boolean(setup || provisioning);
};

export const applicationState = async (env: Bindings, session: SessionRow): Promise<AppState> => {
  const identity = { email: session.email, displayName: session.display_name };
  const control = controlDatabase(env.CONTROL_DB);
  const memberships = await control.select({
    accountId: accountIdentities.accountId,
    name: accounts.name,
    status: accounts.status,
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(
      eq(accountIdentities.identityId, session.identity_id),
      eq(accountIdentities.state, 'active'),
      isNotNull(accounts.databaseId),
    )).all();
  if (memberships.length > 0) {
    const databases = createDatabaseAccess(env);
    await Promise.all(memberships.map(async (membership) => {
      const database = await databases.open({
        kind: 'organization',
        bindingName: membership.bindingName,
        databaseId: membership.databaseId,
      });
      await createAutomation(env).verifyAccountInboxCredential({
        accountId: membership.accountId,
        database: database.raw,
      });
    }));
    return {
      kind: 'ready',
      identity,
      accounts: memberships.map(({ accountId, name, status }) => ({ accountId, name, status })),
    };
  }
  const contactLogin = await control.select({
    accountId: contactLogins.accountId,
    name: accounts.name,
  }).from(contactLogins).innerJoin(accounts, eq(accounts.id, contactLogins.accountId))
    .innerJoin(identities, eq(identities.googleSubject, contactLogins.googleSubject))
    .where(and(eq(identities.id, session.identity_id), eq(accounts.status, 'active'))).get();
  if (contactLogin) {
    return {
      kind: 'member',
      identity,
      account: { accountId: contactLogin.accountId, name: contactLogin.name },
    };
  }
  const setup = await control.select().from(accountSetups)
    .where(eq(accountSetups.ownerIdentityId, session.identity_id)).get();
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
    accountId: accountProvisionings.accountId,
    name: accounts.name,
    state: accountProvisionings.state,
    phase: accountProvisionings.phase,
    errorMessage: accountProvisionings.errorMessage,
    expiresAt: accountProvisionings.expiresAt,
  }).from(accountProvisionings)
    .innerJoin(accounts, eq(accounts.id, accountProvisionings.accountId))
    .where(eq(accountProvisionings.ownerIdentityId, session.identity_id)).get();
  if (provisioning?.state === 'failed') {
    return {
      kind: 'provisioning_failed',
      identity,
      account: { id: provisioning.accountId, name: provisioning.name },
      phase: provisioning.phase,
      error: provisioning.errorMessage,
      retryUntil: provisioning.expiresAt,
    };
  }
  if (provisioning) {
    return {
      kind: 'provisioning',
      identity,
      account: { id: provisioning.accountId, name: provisioning.name },
      phase: provisioning.phase,
    };
  }
  return { kind: 'unassigned', identity };
};

export const retryProvisioning = async (env: Bindings): Promise<void> => {
  const rows = await controlDatabase(env.CONTROL_DB).select().from(accountProvisionings)
    .where(inArray(accountProvisionings.state, ['provisioning', 'failed']))
    .orderBy(asc(accountProvisionings.updatedAt)).limit(10).all();
  for (const provisioning of rows) {
    if (Date.parse(provisioning.expiresAt) <= Date.now()) {
      await discardProvisioning(env, provisioning);
      continue;
    }
    await attemptProvision(env, provisioning);
  }
};
