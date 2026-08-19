import { Hono } from 'hono';
import { and, eq, isNotNull } from 'drizzle-orm';

import { beginGoogleEntry, completeGoogleEntry, entryConfigurationError } from '../entry';
import { createDatabaseAccess } from '../database-access';
import { applicationState, cancelAccountOnboarding, confirmAccount, retryAccountProvisioning } from '../onboarding';
import { json } from '../response';
import { failure } from '../response';
import { createRequestContext } from './request-context';
import { CONTROL_SCHEMA_TARGET } from '../schema-lifecycle';
import type { Bindings } from '../types';
import { controlDatabase } from '../storage/database';
import { accountIdentities, accounts, sessions } from '../storage/control-schema';

export const entryRoutes = new Hono<{ Bindings: Bindings }>();
export const oauthRoutes = new Hono<{ Bindings: Bindings }>();

const sessionCookie = 'mail_session';
const sessionWindowMs = 7 * 24 * 60 * 60 * 1_000;
const now = (): string => new Date().toISOString();
const cookie = (name: string, value: string, secure: boolean, maxAge?: number): string => {
  const secureAttribute = secure ? '; Secure' : '';
  const lifetime = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secureAttribute}${lifetime}`;
};

const requestCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
};

entryRoutes.get('/health', async (context) => {
  const control = await createDatabaseAccess(context.env).open({ kind: 'control' });
  return json(context, {
    status: 'ok',
    service: 'mail-automation',
    time: new Date().toISOString(),
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
  if (input.intent !== 'login' && input.intent !== 'organization_setup') return failure(context, 'Unknown Google entry intent.');
  const invalid = entryConfigurationError(context.env);
  if (invalid) return failure(context, invalid, 503);
  return json(context, {
    authorizationUrl: await beginGoogleEntry(context.env, context.req.raw, input.intent),
  }, 201);
});

oauthRoutes.get('/oauth/google/callback', async (context) => {
  const completed = await completeGoogleEntry(context.env, context.req.query('code'), context.req.query('state'));
  if (completed.sessionId) {
    context.header('Set-Cookie', cookie(
      sessionCookie,
      completed.sessionId,
      new URL(context.req.raw.url).protocol === 'https:',
      Math.floor(sessionWindowMs / 1_000),
    ));
  }
  return context.redirect(completed.location);
});

entryRoutes.post('/onboarding/confirm', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
  try {
    const input = await context.req.json<{ name?: string; presetId?: string }>();
    await confirmAccount(context.env, session.identity_id, input.name ?? '', input.presetId);
    return json(context, { accepted: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Account setup could not be confirmed.', 409);
  }
});

entryRoutes.post('/onboarding/retry', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
  try {
    await retryAccountProvisioning(context.env, session.identity_id);
    return json(context, { accepted: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Account provisioning could not be retried.', 409);
  }
});

entryRoutes.delete('/onboarding', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
  return json(context, { cancelled: await cancelAccountOnboarding(context.env, session.identity_id) });
});

entryRoutes.get('/auth/me', async (context) => {
  const session = await createRequestContext(context.req.raw, context.env).session();
  if (!session) return failure(context, 'Authentication is required.', 401);
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
  const id = requestCookie(context.req.header('Cookie'), sessionCookie);
  if (id) await controlDatabase(context.env.CONTROL_DB).update(sessions).set({ revokedAt: now() }).where(eq(sessions.id, id)).run();
  context.header('Set-Cookie', cookie(sessionCookie, '', new URL(context.req.raw.url).protocol === 'https:', 0));
  return json(context, { loggedOut: true });
});
