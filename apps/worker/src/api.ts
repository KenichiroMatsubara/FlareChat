import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

import { decrypt, encrypt, masterKey } from './cryptography';
import { randomToken, sha256 } from './encoding';
import {
  createPkce,
  exchangeGoogleCode,
  fetchGmailHistoryId,
  fetchGoogleIdentity,
  googleAuthorizationUrl,
  hasCompleteGoogleGrant,
  missingGoogleScopes,
  revokeGoogleToken,
} from './google';
import { createSetupOrganizationKey, provisionSetup } from './provisioning';
import { failure, json } from './response';
import type { Bindings, PasskeyRow, SessionRow, SetupRow } from './types';
import { verifyAuthentication, verifyRegistration } from './webauthn';
import type { AuthenticationResponse } from './webauthn';

const SETUP_COOKIE = 'mail_setup';
const LOGIN_COOKIE = 'mail_login';
const SESSION_COOKIE = 'mail_session';
const SETUP_WINDOW_MS = 15 * 60 * 1_000;
const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSKEY_WINDOW_MS = 5 * 60 * 1_000;

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const redirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/google/callback`;
const setupView = (row: SetupRow): OrganizationSetup => ({
  id: row.id,
  name: row.name,
  inboxAddress: row.inbox_address,
  status: row.state,
  expiresAt: row.expires_at,
  provisioningExpiresAt: row.provisioning_expires_at,
  error: row.error_message,
});

const cookie = (name: string, value: string, secure: boolean, maxAge?: number): string => {
  const secureAttribute = secure ? '; Secure' : '';
  const lifetime = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secureAttribute}${lifetime}`;
};

const requestIsSecure = (request: Request): boolean => new URL(request.url).protocol === 'https:';

const requestCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
};

const setupFromRequest = async (request: Request, env: Bindings): Promise<SetupRow | null> => {
  const id = requestCookie(request.headers.get('Cookie') ?? undefined, SETUP_COOKIE);
  if (!id) return null;
  return env.CONTROL_DB.prepare('SELECT * FROM organization_setups WHERE id = ?').bind(id).first<SetupRow>();
};

const validSetup = (row: SetupRow | null, state: SetupRow['state']): SetupRow => {
  if (!row || row.state !== state || Date.parse(row.expires_at) <= Date.now()) throw new Error('Setup session expired.');
  return row;
};

const configurationError = (env: Bindings): string | null => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return 'Google OAuth credentials are not configured.';
  if (!env.CREDENTIAL_MASTER_KEY || !env.CREDENTIAL_MASTER_KEY_VERSION) return 'Credential encryption is not configured.';
  return null;
};

app.get('/api/health', (context) => json(context, { status: 'ok', service: 'mail-automation', time: now() }));

app.post('/api/setup', async (context) => {
  const input = await context.req.json<{ name?: string }>();
  const name = input.name?.trim();
  if (!name) return failure(context, '組織名を入力してください。');
  const invalid = configurationError(context.env);
  if (invalid) return failure(context, invalid, 503);
  const id = crypto.randomUUID();
  const state = randomToken();
  const pkce = await createPkce();
  const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
  const verifierEnvelope = await encrypt(pkce.verifier, key, `setup-pkce:${id}`);
  const createdAt = now();
  const expiresAt = expiresIn(SETUP_WINDOW_MS);
  await context.env.CONTROL_DB.prepare(
    `INSERT INTO organization_setups (id, name, state, oauth_state_hash, pkce_verifier_envelope, expires_at, created_at, updated_at)
     VALUES (?, ?, 'awaiting_google', ?, ?, ?, ?, ?)`,
  ).bind(id, name, await sha256(state), JSON.stringify(verifierEnvelope), expiresAt, createdAt, createdAt).run();
  context.header('Set-Cookie', cookie(SETUP_COOKIE, id, requestIsSecure(context.req.raw), Math.floor(SETUP_WINDOW_MS / 1_000)));
  return json(context, { authorizationUrl: googleAuthorizationUrl({ clientId: context.env.GOOGLE_CLIENT_ID, redirectUri: redirectUri(context.env), state, challenge: pkce.challenge }) }, 201);
});

app.get('/oauth/google/callback', async (context) => {
  const code = context.req.query('code');
  const state = context.req.query('state');
  const target = new URL('/setup', context.env.WEB_ORIGIN || context.env.APP_URL);
  if (!code || !state) {
    target.searchParams.set('error', 'Google authorization was cancelled.');
    return context.redirect(target.toString());
  }
  const row = await context.env.CONTROL_DB.prepare('SELECT * FROM organization_setups WHERE oauth_state_hash = ?').bind(await sha256(state)).first<SetupRow>();
  try {
    const setup = validSetup(row, 'awaiting_google');
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(setup.pkce_verifier_envelope), key, `setup-pkce:${setup.id}`);
    const tokenSet = await exchangeGoogleCode({ code, verifier, clientId: context.env.GOOGLE_CLIENT_ID, clientSecret: context.env.GOOGLE_CLIENT_SECRET, redirectUri: redirectUri(context.env) });
    if (!hasCompleteGoogleGrant(tokenSet.scopes)) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await expireSetup(context.env, setup);
      target.searchParams.set('error', `Required Google permissions are missing: ${missingGoogleScopes(tokenSet.scopes).join(', ')}`);
      return context.redirect(target.toString());
    }
    const [identity, historyId] = await Promise.all([fetchGoogleIdentity(tokenSet.accessToken), fetchGmailHistoryId(tokenSet.accessToken)]);
    const existing = await context.env.CONTROL_DB.prepare(
      `SELECT id FROM organizations WHERE inbox_address = ?
       UNION ALL SELECT id FROM organization_setups WHERE inbox_address = ? AND id <> ? LIMIT 1`,
    ).bind(identity.email, identity.email, setup.id).first<{ id: string }>();
    if (existing) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await expireSetup(context.env, setup);
      target.searchParams.set('error', 'This Automation Inbox is already assigned to an Organization.');
      return context.redirect(target.toString());
    }
    const credentialEnvelope = await encrypt(JSON.stringify(tokenSet), key, `setup-credential:${setup.id}`);
    await context.env.CONTROL_DB.prepare(
      `UPDATE organization_setups
       SET state = 'awaiting_passkey', inbox_address = ?, google_subject = ?, granted_scopes = ?, credential_envelope = ?, history_id = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(identity.email, identity.subject, JSON.stringify(tokenSet.scopes), JSON.stringify(credentialEnvelope), historyId, expiresIn(SETUP_WINDOW_MS), now(), setup.id).run();
    context.header('Set-Cookie', cookie(SETUP_COOKIE, setup.id, requestIsSecure(context.req.raw), Math.floor(SETUP_WINDOW_MS / 1_000)));
  } catch (error) {
    target.searchParams.set('error', error instanceof Error ? error.message : 'Google authorization failed.');
  }
  return context.redirect(target.toString());
});

app.get('/api/setup/current', async (context) => {
  const row = await setupFromRequest(context.req.raw, context.env);
  if (!row) return json(context, null);
  if ((row.state === 'awaiting_google' || row.state === 'awaiting_passkey') && Date.parse(row.expires_at) <= Date.now()) {
    await expireSetup(context.env, row);
    return json(context, { ...setupView(row), status: 'expired' });
  }
  return json(context, setupView(row));
});

app.post('/api/setup/passkey/options', async (context) => {
  try {
    const setup = validSetup(await setupFromRequest(context.req.raw, context.env), 'awaiting_passkey');
    if (!setup.inbox_address) throw new Error('Setup is missing the Automation Inbox.');
    const challenge = randomToken();
    await context.env.CONTROL_DB.prepare('UPDATE organization_setups SET passkey_challenge_hash = ?, updated_at = ? WHERE id = ?')
      .bind(await sha256(challenge), now(), setup.id).run();
    const options: PasskeyCreationOptions = {
      challenge,
      rp: { id: context.env.RP_ID, name: 'Mail Automation' },
      user: { id: randomToken(16), name: setup.inbox_address, displayName: setup.inbox_address },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: PASSKEY_WINDOW_MS,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
    };
    return json(context, options);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Passkey setup failed.', 409);
  }
});

app.post('/api/setup/passkey/verify', async (context) => {
  try {
    const setup = validSetup(await setupFromRequest(context.req.raw, context.env), 'awaiting_passkey');
    if (!setup.passkey_challenge_hash || !setup.inbox_address || !setup.google_subject) throw new Error('Passkey registration was not started.');
    const credential = await verifyRegistration(await context.req.json(), setup.passkey_challenge_hash, context.env.RP_ID, context.env.WEB_ORIGIN);
    const organizationId = crypto.randomUUID();
    const identityId = crypto.randomUUID();
    const bindingName = `ORG_${organizationId.replaceAll('-', '')}`;
    const createdAt = now();
    await context.env.CONTROL_DB.batch([
      context.env.CONTROL_DB.prepare('INSERT INTO organizations (id, name, inbox_address, status, binding_name, created_at, updated_at) VALUES (?, ?, ?, \'provisioning\', ?, ?, ?)').bind(organizationId, setup.name, setup.inbox_address, bindingName, createdAt, createdAt),
      context.env.CONTROL_DB.prepare('INSERT INTO identities (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(identityId, setup.inbox_address, setup.inbox_address, createdAt, createdAt),
      context.env.CONTROL_DB.prepare("INSERT INTO members (organization_id, identity_id, role, state, created_at, updated_at) VALUES (?, ?, 'owner', 'pending', ?, ?)").bind(organizationId, identityId, createdAt, createdAt),
      context.env.CONTROL_DB.prepare('INSERT INTO passkeys (id, identity_id, credential_id, public_key_jwk, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), identityId, credential.credentialId, JSON.stringify(credential.publicKeyJwk), credential.signCount, JSON.stringify(credential.transports), createdAt),
      context.env.CONTROL_DB.prepare("UPDATE organization_setups SET state = 'provisioning', owner_identity_id = ?, organization_id = ?, binding_name = ?, provisioning_key = ?, provisioning_expires_at = ?, passkey_challenge_hash = NULL, updated_at = ? WHERE id = ?").bind(identityId, organizationId, bindingName, crypto.randomUUID(), expiresIn(PROVISIONING_WINDOW_MS), createdAt, setup.id),
    ]);
    await createSetupOrganizationKey(context.env, organizationId);
    const current = await context.env.CONTROL_DB.prepare('SELECT * FROM organization_setups WHERE id = ?').bind(setup.id).first<SetupRow>();
    if (current) await attemptProvision(context.env, current);
    return json(context, current ? setupView(current) : { ...setupView(setup), status: 'provisioning' }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Passkey registration failed.', 409);
  }
});

app.post('/api/auth/passkey/options', async (context) => {
  const input = await context.req.json<{ email?: string }>();
  const email = input.email?.trim().toLowerCase();
  if (!email) return failure(context, 'Email is required.');
  const identity = await context.env.CONTROL_DB.prepare(
    `SELECT i.id FROM identities i JOIN members m ON m.identity_id = i.id
     WHERE i.email = ? AND m.state = 'active' LIMIT 1`,
  ).bind(email).first<{ id: string }>();
  if (!identity) return failure(context, 'No active member has that email address.', 404);
  const challengeId = crypto.randomUUID();
  const challenge = randomToken();
  await context.env.CONTROL_DB.prepare('INSERT INTO passkey_challenges (id, identity_id, challenge_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(challengeId, identity.id, await sha256(challenge), expiresIn(PASSKEY_WINDOW_MS), now()).run();
  const keys = await context.env.CONTROL_DB.prepare('SELECT credential_id FROM passkeys WHERE identity_id = ?').bind(identity.id).all<{ credential_id: string }>();
  context.header('Set-Cookie', cookie(LOGIN_COOKIE, challengeId, requestIsSecure(context.req.raw), Math.floor(PASSKEY_WINDOW_MS / 1_000)));
  return json(context, { challenge, rpId: context.env.RP_ID, timeout: PASSKEY_WINDOW_MS, userVerification: 'required', allowCredentials: keys.results.map((key) => ({ type: 'public-key', id: key.credential_id })) });
});

app.post('/api/auth/passkey/verify', async (context) => {
  const challengeId = requestCookie(context.req.header('Cookie'), LOGIN_COOKIE);
  if (!challengeId) return failure(context, 'Login challenge is missing.', 401);
  const challenge = await context.env.CONTROL_DB.prepare('SELECT * FROM passkey_challenges WHERE id = ? AND expires_at > ?').bind(challengeId, now()).first<{ id: string; identity_id: string; challenge_hash: string }>();
  if (!challenge) return failure(context, 'Login challenge expired.', 401);
  const response = await context.req.json<AuthenticationResponse>();
  const passkey = await context.env.CONTROL_DB.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND identity_id = ?').bind(response.rawId, challenge.identity_id).first<PasskeyRow>();
  if (!passkey) return failure(context, 'Unknown passkey.', 401);
  try {
    const signCount = await verifyAuthentication(response, challenge.challenge_hash, context.env.RP_ID, context.env.WEB_ORIGIN, { credentialId: passkey.credential_id, publicKeyJwk: JSON.parse(passkey.public_key_jwk), signCount: passkey.sign_count });
    const sessionId = randomToken();
    await context.env.CONTROL_DB.batch([
      context.env.CONTROL_DB.prepare('DELETE FROM passkey_challenges WHERE id = ?').bind(challenge.id),
      context.env.CONTROL_DB.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').bind(signCount, now(), passkey.id),
      context.env.CONTROL_DB.prepare('INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').bind(sessionId, challenge.identity_id, expiresIn(SESSION_WINDOW_MS), now(), now()),
    ]);
    context.header('Set-Cookie', cookie(SESSION_COOKIE, sessionId, requestIsSecure(context.req.raw), Math.floor(SESSION_WINDOW_MS / 1_000)));
    return json(context, { authenticated: true });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Passkey authentication failed.', 401);
  }
});

app.get('/api/auth/me', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  const memberships = await context.env.CONTROL_DB.prepare(
    `SELECT m.organization_id AS organizationId, m.role, o.name, o.status
     FROM members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.identity_id = ? AND m.state = 'active'`,
  ).bind(session.identity_id).all<{ organizationId: string; role: string; name: string; status: string }>();
  return json(context, { email: session.email, displayName: session.display_name, organizations: memberships.results });
});

app.post('/api/auth/logout', async (context) => {
  const sessionId = requestCookie(context.req.header('Cookie'), SESSION_COOKIE);
  if (sessionId) await context.env.CONTROL_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(now(), sessionId).run();
  context.header('Set-Cookie', cookie(SESSION_COOKIE, '', requestIsSecure(context.req.raw), 0));
  return json(context, { loggedOut: true });
});

app.all('/api/*', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  return failure(context, 'The previous shared-ORG_DB management API has been retired. Organization-scoped operations are introduced in the next implementation unit.', 410);
});

const sessionFromRequest = async (request: Request, env: Bindings): Promise<SessionRow | null> => {
  const id = requestCookie(request.headers.get('Cookie') ?? undefined, SESSION_COOKIE);
  if (!id) return null;
  return env.CONTROL_DB.prepare(
    `SELECT s.id, s.identity_id, i.email, i.display_name FROM sessions s JOIN identities i ON i.id = s.identity_id
     WHERE s.id = ? AND s.expires_at > ? AND s.revoked_at IS NULL`,
  ).bind(id, now()).first<SessionRow>();
};

const attemptProvision = async (env: Bindings, setup: SetupRow): Promise<void> => {
  try {
    if (setup.organization_id) await createSetupOrganizationKey(env, setup.organization_id);
    await provisionSetup(env, setup);
  } catch (error) {
    await env.CONTROL_DB.prepare("UPDATE organization_setups SET state = 'provisioning', error_message = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : 'Provisioning failed.', now(), setup.id).run();
  }
};

export const retryProvisioning = async (env: Bindings): Promise<void> => {
  const rows = await env.CONTROL_DB.prepare("SELECT * FROM organization_setups WHERE state = 'provisioning' ORDER BY updated_at LIMIT 10").all<SetupRow>();
  for (const setup of rows.results) {
    if (!setup.provisioning_expires_at || Date.parse(setup.provisioning_expires_at) <= Date.now()) {
      await expireSetup(env, setup);
      continue;
    }
    await attemptProvision(env, setup);
  }
};

const expireSetup = async (env: Bindings, setup: SetupRow): Promise<void> => {
  if (setup.credential_envelope) {
    try {
      const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
      const tokens = JSON.parse(await decrypt(JSON.parse(setup.credential_envelope), key, `setup-credential:${setup.id}`)) as { refreshToken?: string };
      if (tokens.refreshToken) await revokeGoogleToken(tokens.refreshToken);
    } catch {
      // Expiry must still erase local credentials when revocation is unavailable.
    }
  }
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE organization_setups SET state = 'expired', credential_envelope = NULL, pkce_verifier_envelope = '', passkey_challenge_hash = NULL, error_message = 'Setup expired.', updated_at = ? WHERE id = ?").bind(now(), setup.id),
    env.CONTROL_DB.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?').bind(now()),
  ]);
};

export { app };
