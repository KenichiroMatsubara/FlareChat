import { and, eq, isNotNull } from 'drizzle-orm';

import { now } from '../clock';
import { createDatabaseAccess } from '../database-access';
import { beginGoogleEntry, completeGoogleEntry, entryConfigurationError } from '../entry';
import { applicationState, cancelAccountOnboarding, confirmAccount, retryAccountProvisioning } from '../onboarding';
import { invalid, upstream } from '../refusal';
import { json, resource } from '../response';
import { CONTROL_SCHEMA_TARGET } from '../schema-lifecycle';
import { createRequestContext, requestCookie, SESSION_COOKIE } from './request-context';
import { controlDatabase } from '../storage/database';
import { accountIdentities, accounts, sessions } from '../storage/control-schema';

export const entryRoutes = resource();
export const oauthRoutes = resource();

const sessionWindowMs = 7 * 24 * 60 * 60 * 1_000;
const cookie = (name: string, value: string, secure: boolean, maxAge?: number): string => {
  const secureAttribute = secure ? '; Secure' : '';
  const lifetime = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secureAttribute}${lifetime}`;
};

entryRoutes.get('/health', async (context) => {
  const control = await createDatabaseAccess(context.env).open({ kind: 'control' });
  return json(context, {
    status: 'ok',
    service: 'mail-automation',
    time: now(),
    database: {
      control: {
        currentMigration: control.schema.currentMigration,
        expectedMigration: CONTROL_SCHEMA_TARGET,
      },
    },
  });
});

entryRoutes.post('/entry/google', async (context) => {
  const input = await context.req.json<{ intent?: 'login' | 'organization_setup' }>();
  if (input.intent !== 'login' && input.intent !== 'organization_setup') throw invalid('Unknown Google entry intent.');
  const misconfigured = entryConfigurationError(context.env);
  if (misconfigured) throw upstream(misconfigured);
  return json(context, { authorizationUrl: await beginGoogleEntry(context.env, context.req.raw, input.intent) }, 201);
});

oauthRoutes.get('/oauth/google/callback', async (context) => {
  const completed = await completeGoogleEntry(context.env, context.req.query('code'), context.req.query('state'));
  if (completed.sessionId) {
    context.header('Set-Cookie', cookie(
      SESSION_COOKIE,
      completed.sessionId,
      new URL(context.req.raw.url).protocol === 'https:',
      Math.floor(sessionWindowMs / 1_000),
    ));
  }
  return context.redirect(completed.location);
});

entryRoutes.post('/onboarding/confirm', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  const input = await context.req.json<{ name?: string; presetId?: string }>();
  await confirmAccount(context.env, session.identity_id, input.name ?? '', input.presetId);
  return json(context, { accepted: true });
});

entryRoutes.post('/onboarding/retry', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  await retryAccountProvisioning(context.env, session.identity_id);
  return json(context, { accepted: true });
});

entryRoutes.delete('/onboarding', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  return json(context, { cancelled: await cancelAccountOnboarding(context.env, session.identity_id) });
});

entryRoutes.get('/auth/me', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  const memberships = await controlDatabase(context.env.CONTROL_DB).select({
    accountId: accountIdentities.accountId,
    name: accounts.name,
    status: accounts.status,
  }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(and(eq(accountIdentities.identityId, session.identity_id), eq(accountIdentities.state, 'active'), isNotNull(accounts.databaseId))).all();
  return json(context, { email: session.email, displayName: session.display_name, accounts: memberships });
});

entryRoutes.get('/bootstrap', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return json(context, { kind: 'signed_out' });
  return json(context, await applicationState(context.env, session));
});

entryRoutes.post('/auth/logout', async (context) => {
  const id = requestCookie(context.req.header('Cookie'), SESSION_COOKIE);
  if (id) await controlDatabase(context.env.CONTROL_DB).update(sessions).set({ revokedAt: now() }).where(eq(sessions.id, id)).run();
  context.header('Set-Cookie', cookie(SESSION_COOKIE, '', new URL(context.req.raw.url).protocol === 'https:', 0));
  return json(context, { loggedOut: true });
});
