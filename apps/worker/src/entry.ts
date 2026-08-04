import { and, eq, gt, inArray, or } from 'drizzle-orm';

import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { randomToken, sha256 } from './encoding';
import {
  createPkce,
  exchangeGoogleCode,
  fetchGmailHistoryId,
  fetchGoogleIdentity,
  GOOGLE_IDENTITY_SCOPES,
  googleAuthorizationUrl,
  hasCompleteGoogleGrant,
  missingGoogleScopes,
  revokeGoogleToken,
} from './google';
import { loginReturnOrigin } from './origin';
import { createDatabaseAccess } from './database-access';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import {
  admins,
  automationInboxClaims,
  identities,
  oauthFlows,
  organizationKeys,
  organizationSetups,
  organizations,
  sessions,
} from './storage/control-schema';
import { googleConnections } from './storage/organization-schema';
import type { Bindings } from './types';

export type GoogleEntryIntent = 'login' | 'organization_setup';

export interface GoogleEntryCompletion {
  location: string;
  sessionId?: string;
}

interface GoogleEntryOptions {
  recoveryOrganizationId?: string;
}

const SETUP_WINDOW_MS = 15 * 60 * 1_000;
const OAUTH_WINDOW_MS = 10 * 60 * 1_000;
const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const redirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/google/callback`;
const recoveryReturnOrigin = (env: Bindings, organizationId: string): string => {
  const target = new URL(`/organizations/${encodeURIComponent(organizationId)}/automation`, env.WEB_ORIGIN || env.APP_URL);
  target.searchParams.set('automation_reauthorization', organizationId);
  return target.toString();
};
const recoveryOrganizationIdFrom = (returnOrigin: string): string | null => {
  const target = new URL(returnOrigin);
  return target.searchParams.get('automation_reauthorization');
};

export const entryConfigurationError = (env: Bindings): string | null => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return 'Google OAuth credentials are not configured.';
  if (!env.CREDENTIAL_MASTER_KEY || !env.CREDENTIAL_MASTER_KEY_VERSION) return 'Credential encryption is not configured.';
  return null;
};

export const beginGoogleEntry = async (
  env: Bindings,
  request: Request,
  intent: GoogleEntryIntent,
  options: GoogleEntryOptions = {},
): Promise<string> => {
  const id = crypto.randomUUID();
  const state = randomToken();
  const pkce = await createPkce();
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const createdAt = now();
  const verifierEnvelope = await encrypt(pkce.verifier, key, `oauth-flow-pkce:${id}`);
  const returnOrigin = options.recoveryOrganizationId
    ? recoveryReturnOrigin(env, options.recoveryOrganizationId)
    : intent === 'login'
    ? loginReturnOrigin(request, env.APP_URL, env.WEB_ORIGIN)
    : env.WEB_ORIGIN || env.APP_URL;
  await controlDatabase(env.CONTROL_DB).insert(oauthFlows).values({
    id,
    intent,
    stateHash: await sha256(state),
    pkceVerifierEnvelope: JSON.stringify(verifierEnvelope),
    returnOrigin,
    expiresAt: expiresIn(OAUTH_WINDOW_MS),
    createdAt,
  }).run();
  return googleAuthorizationUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(env),
    state,
    challenge: pkce.challenge,
    ...(intent === 'login' ? { scopes: GOOGLE_IDENTITY_SCOPES } : {}),
  });
};

const locationWithError = (target: URL, message: string): GoogleEntryCompletion => {
  target.searchParams.set('error', message);
  return { location: target.toString() };
};

export const completeGoogleEntry = async (
  env: Bindings,
  code: string | undefined,
  state: string | undefined,
): Promise<GoogleEntryCompletion> => {
  let target = new URL('/setup', env.WEB_ORIGIN || env.APP_URL);
  if (!code || !state) return locationWithError(target, 'Google authorization was cancelled.');
  const control = controlDatabase(env.CONTROL_DB);
  const flow = await control.select().from(oauthFlows).where(and(
    eq(oauthFlows.stateHash, await sha256(state)),
    gt(oauthFlows.expiresAt, now()),
  )).get();
  if (!flow) return locationWithError(target, 'Google authorization flow expired.');
  const recoveryOrganizationId = flow.intent === 'organization_setup' ? recoveryOrganizationIdFrom(flow.returnOrigin) : null;
  target = recoveryOrganizationId
    ? new URL(flow.returnOrigin)
    : new URL(flow.intent === 'login' ? '/' : '/setup', flow.returnOrigin);
  try {
    const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(flow.pkceVerifierEnvelope), key, `oauth-flow-pkce:${flow.id}`);
    const tokenSet = await exchangeGoogleCode({
      code,
      verifier,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(env),
    });
    const identity = await fetchGoogleIdentity(tokenSet.accessToken);
    const timestamp = now();
    await control.insert(identities).values({
      id: crypto.randomUUID(),
      googleSubject: identity.subject,
      email: identity.email,
      displayName: identity.displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: identities.googleSubject,
      set: { email: identity.email, displayName: identity.displayName, updatedAt: timestamp },
    }).run();
    const owner = await control.select({ id: identities.id }).from(identities)
      .where(eq(identities.googleSubject, identity.subject)).get();
    if (!owner) throw new Error('Google identity could not be stored.');
    const sessionId = randomToken();
    const completeAsLogin = async (location: URL): Promise<GoogleEntryCompletion> => {
      await revokeGoogleToken(tokenSet.refreshToken);
      await control.batch([
        control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)),
        control.insert(sessions).values({
          id: sessionId,
          identityId: owner.id,
          expiresAt: expiresIn(SESSION_WINDOW_MS),
          createdAt: timestamp,
          lastSeenAt: timestamp,
        }),
      ]);
      return { location: location.toString(), sessionId };
    };
    if (flow.intent === 'login') {
      return await completeAsLogin(target);
    }
    if (!recoveryOrganizationId) {
      const existingMembership = await control.select({ organizationId: admins.organizationId }).from(admins)
        .where(and(
          eq(admins.identityId, owner.id),
          eq(admins.state, 'active'),
        )).get();
      if (existingMembership) {
        return await completeAsLogin(new URL('/', flow.returnOrigin));
      }
    }
    if (!hasCompleteGoogleGrant(tokenSet.scopes)) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)).run();
      return locationWithError(
        target,
        `Required Google permissions are missing: ${missingGoogleScopes(tokenSet.scopes).join(', ')}`,
      );
    }
    if (recoveryOrganizationId) {
      const authorizedOrganization = await control.select({
        id: organizations.id,
        databaseId: organizations.databaseId,
        bindingName: organizations.bindingName,
      }).from(admins).innerJoin(organizations, eq(organizations.id, admins.organizationId)).where(and(
        eq(admins.organizationId, recoveryOrganizationId),
        eq(admins.identityId, owner.id),
        eq(admins.state, 'active'),
        inArray(admins.role, ['owner', 'admin']),
        eq(organizations.status, 'active'),
      )).get();
      if (!authorizedOrganization) throw new Error('この Automation Inbox を再接続する権限がありません。');
      const database = await createDatabaseAccess(env).open({
        kind: 'organization',
        bindingName: authorizedOrganization.bindingName,
        databaseId: authorizedOrganization.databaseId,
      });
      const organization = drizzleOrganizationDatabase(database.raw);
      const inbox = await organization.select().from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get();
      if (!inbox || inbox.googleSubject !== identity.subject) {
        await revokeGoogleToken(tokenSet.refreshToken);
        await control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)).run();
        return locationWithError(target, 'Automation Inbox は同じ Google アカウントで再接続してください。');
      }
      const organizationKeyRecord = await control.select({
        masterKeyVersion: organizationKeys.masterKeyVersion,
        wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
      }).from(organizationKeys).where(eq(organizationKeys.organizationId, recoveryOrganizationId)).get();
      if (!organizationKeyRecord) throw new Error('Organization encryption key is missing.');
      const organizationKey = await unwrapOrganizationKey({
        masterKeyVersion: organizationKeyRecord.masterKeyVersion,
        envelope: JSON.parse(organizationKeyRecord.wrappedKeyEnvelope),
      }, key, recoveryOrganizationId);
      const historyId = await fetchGmailHistoryId(tokenSet.accessToken);
      const credentialEnvelope = await encrypt(
        JSON.stringify(tokenSet),
        organizationKey,
        `google-connection:${recoveryOrganizationId}:automation-inbox`,
      );
      await organization.update(googleConnections).set({
        inboxAddress: identity.email,
        grantedScopes: JSON.stringify(tokenSet.scopes),
        tokenEnvelope: JSON.stringify(credentialEnvelope),
        gmailHistoryId: historyId,
        status: 'active',
        lastError: null,
        updatedAt: timestamp,
      }).where(eq(googleConnections.id, inbox.id)).run();
      await control.batch([
        control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)),
        control.insert(sessions).values({
          id: sessionId,
          identityId: owner.id,
          expiresAt: expiresIn(SESSION_WINDOW_MS),
          createdAt: timestamp,
          lastSeenAt: timestamp,
        }),
      ]);
      return { location: target.toString(), sessionId };
    }
    const existingClaim = await control.select({ googleSubject: automationInboxClaims.googleSubject })
      .from(automationInboxClaims)
      .where(or(
        eq(automationInboxClaims.googleSubject, identity.subject),
        eq(automationInboxClaims.inboxAddress, identity.email),
      )).get();
    if (existingClaim) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)).run();
      return locationWithError(target, 'automation_inbox_already_claimed');
    }
    const historyId = await fetchGmailHistoryId(tokenSet.accessToken);
    const setupId = crypto.randomUUID();
    const credentialEnvelope = await encrypt(
      JSON.stringify(tokenSet),
      key,
      `automation-inbox-token:${identity.subject}`,
    );
    await control.batch([
      control.insert(organizationSetups).values({
        id: setupId,
        name: identity.displayName || identity.email,
        inboxAddress: identity.email,
        googleSubject: identity.subject,
        grantedScopes: JSON.stringify(tokenSet.scopes),
        credentialEnvelope: JSON.stringify(credentialEnvelope),
        historyId,
        ownerIdentityId: owner.id,
        expiresAt: expiresIn(SETUP_WINDOW_MS),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      control.insert(automationInboxClaims).values({
        googleSubject: identity.subject,
        inboxAddress: identity.email,
        setupId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      control.delete(oauthFlows).where(eq(oauthFlows.id, flow.id)),
      control.insert(sessions).values({
        id: sessionId,
        identityId: owner.id,
        expiresAt: expiresIn(SESSION_WINDOW_MS),
        createdAt: timestamp,
        lastSeenAt: timestamp,
      }),
    ]);
    return { location: target.toString(), sessionId };
  } catch (error) {
    return locationWithError(
      target,
      error instanceof Error ? error.message : 'Google authorization failed.',
    );
  }
};
