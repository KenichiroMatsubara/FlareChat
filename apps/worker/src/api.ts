import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { canUpdateAttendance, discoveredLineDestinations, displayRecipientIdentifier, verifyLineWebhookSignature } from '@mail/domain';
import type { OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

import { runAutomationForIdentity } from './automation';
import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
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
import { loginReturnOrigin } from './origin';
import { createSetupOrganizationKey, provisionSetup } from './provisioning';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt } from './recovery-receipts';
import { exportRecipientCsv, previewRecipientCsv } from './recipients';
import { failure, json } from './response';
import type { Bindings, ConnectionRow, GoogleAutomationRow, OrganizationConnectionRow, OrganizationRow, PasskeyRow, SessionRow, SetupRow } from './types';
import { verifyAuthentication, verifyRegistration } from './webauthn';
import type { AuthenticationResponse } from './webauthn';

const SETUP_COOKIE = 'mail_setup';
const LOGIN_COOKIE = 'mail_login';
const SESSION_COOKIE = 'mail_session';
const SETUP_WINDOW_MS = 15 * 60 * 1_000;
const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSKEY_WINDOW_MS = 5 * 60 * 1_000;
const GOOGLE_LOGIN_WINDOW_MS = 10 * 60 * 1_000;
const RECIPIENT_LINK_WINDOW_MS = 15 * 60 * 1_000;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

type OrganizationCredential = Record<string, string>;

interface OrganizationConnectionInput {
  line?: {
    channelAccessToken?: string;
    channelSecret?: string;
  };
  ai?: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));

const now = (): string => new Date().toISOString();
const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const redirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/google/callback`;
const googleLoginRedirectUri = (env: Bindings): string => `${env.APP_URL.replace(/\/$/u, '')}/oauth/google/login/callback`;
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

const organizationDatabase = (env: Bindings, bindingName: string): D1Database | null => {
  const database = (env as unknown as Record<string, unknown>)[bindingName];
  return database && typeof database === 'object' ? database as D1Database : null;
};

const ensureGoogleOrganization = async (
  env: Bindings,
  identityId: string,
  email: string,
  displayName: string,
): Promise<void> => {
  const membership = await env.CONTROL_DB.prepare("SELECT organization_id FROM members WHERE identity_id = ? AND state = 'active' LIMIT 1")
    .bind(identityId).first<{ organization_id: string }>();
  if (membership) return;
  const orphanOrganizations = await env.CONTROL_DB.prepare(
    `SELECT o.id, o.name, o.inbox_address, o.status, o.database_id, o.binding_name
     FROM organizations o LEFT JOIN members m ON m.organization_id = o.id
     WHERE o.status = 'active'
     GROUP BY o.id
     HAVING COUNT(m.identity_id) = 0
     ORDER BY o.created_at
     LIMIT 2`,
  ).all<OrganizationRow & { inbox_address: string }>();
  const occupiedInbox = await env.CONTROL_DB.prepare('SELECT id FROM organizations WHERE inbox_address = ? LIMIT 1')
    .bind(email).first<{ id: string }>();
  if (occupiedInbox && !orphanOrganizations.results.some((organization) => organization.id === occupiedInbox.id)) return;
  const organization = orphanOrganizations.results.length === 1 ? orphanOrganizations.results[0] : undefined;
  const organizationId = organization?.id ?? crypto.randomUUID();
  const createdAt = now();
  if (!organization) {
    await env.CONTROL_DB.prepare(
      "INSERT INTO organizations (id, name, inbox_address, status, binding_name, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
    ).bind(organizationId, `${displayName || email} の組織`, email, `ORG_${organizationId.replaceAll('-', '')}`, createdAt, createdAt).run();
  }
  await env.CONTROL_DB.prepare(
    "INSERT OR IGNORE INTO members (organization_id, identity_id, role, state, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)",
  ).bind(organizationId, identityId, createdAt, createdAt).run();
  await createSetupOrganizationKey(env, organizationId);
};

const organizationForRequest = async (
  request: Request,
  env: Bindings,
  organizationId: string,
): Promise<{ session: SessionRow; organization: OrganizationRow; role: string; database: D1Database | null }> => {
  const session = await sessionFromRequest(request, env);
  if (!session) throw new Error('Authentication is required.');
  const membership = await env.CONTROL_DB.prepare(
    `SELECT m.role, o.id, o.name, o.status, o.database_id, o.binding_name
     FROM members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.identity_id = ? AND m.organization_id = ? AND m.state = 'active'`,
  ).bind(session.identity_id, organizationId).first<OrganizationRow & { role: string }>();
  if (!membership) throw new Error('この組織へのアクセス権がありません。');
  if (membership.status !== 'active') throw new Error('この組織は現在利用できません。');
  const database = organizationDatabase(env, membership.binding_name);
  return { session, organization: membership, role: membership.role, database };
};

const connectionContext = (organizationId: string, kind: 'line' | 'ai'): string => `organization-connection:${organizationId}:${kind}`;

const connectionCredential = async (
  row: ConnectionRow | null,
  key: CryptoKey,
  organizationId: string,
  kind: 'line' | 'ai',
): Promise<OrganizationCredential> => {
  if (!row) return {};
  return JSON.parse(await decrypt(JSON.parse(row.credential), key, connectionContext(organizationId, kind))) as OrganizationCredential;
};

const connectionView = (line: OrganizationCredential, ai: OrganizationCredential) => ({
  line: {
    channelAccessTokenConfigured: Boolean(line.channelAccessToken),
    channelSecretConfigured: Boolean(line.channelSecret),
  },
  ai: {
    apiKeyConfigured: Boolean(ai.apiKey),
    provider: ai.provider ?? '',
    model: ai.model ?? '',
    baseUrl: ai.baseUrl ?? '',
    authMode: ai.authMode ?? 'api_key',
    gcpProjectId: ai.gcpProjectId ?? '',
    gcpLocation: ai.gcpLocation ?? '',
    oauthConfigured: Boolean(ai.oauthRefreshToken),
  },
});

export const generatedText = (response: GeminiGenerateContentResponse): string =>
  response.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text ?? '').join('').trim() ?? '';

app.get('/api/health', (context) => json(context, { status: 'ok', service: 'mail-automation', time: now() }));

app.post('/api/auth/google', async (context) => {
  const invalid = configurationError(context.env);
  if (invalid) return failure(context, invalid, 503);
  const id = crypto.randomUUID();
  const state = randomToken();
  const pkce = await createPkce();
  const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
  const verifierEnvelope = await encrypt(pkce.verifier, key, `google-login-pkce:${id}`);
  const returnOrigin = loginReturnOrigin(context.req.raw, context.env.APP_URL, context.env.WEB_ORIGIN);
  await context.env.CONTROL_DB.prepare(
    'INSERT INTO google_login_states (id, state_hash, pkce_verifier_envelope, return_origin, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, await sha256(state), JSON.stringify(verifierEnvelope), returnOrigin, expiresIn(GOOGLE_LOGIN_WINDOW_MS), now()).run();
  return json(context, {
    authorizationUrl: googleAuthorizationUrl({
      clientId: context.env.GOOGLE_CLIENT_ID,
      redirectUri: googleLoginRedirectUri(context.env),
      state,
      challenge: pkce.challenge,
    }),
  }, 201);
});

app.get('/oauth/google/login/callback', async (context) => {
  let target = new URL('/', context.env.WEB_ORIGIN || context.env.APP_URL);
  const code = context.req.query('code');
  const state = context.req.query('state');
  if (!code || !state) {
    target.searchParams.set('error', 'Google ログインがキャンセルされました。');
    return context.redirect(target.toString());
  }
  const login = await context.env.CONTROL_DB.prepare(
    'SELECT id, pkce_verifier_envelope, return_origin FROM google_login_states WHERE state_hash = ? AND expires_at > ?',
  ).bind(await sha256(state), now()).first<{ id: string; pkce_verifier_envelope: string; return_origin: string }>();
  if (!login) {
    target.searchParams.set('error', 'Google ログインの有効期限が切れました。もう一度お試しください。');
    return context.redirect(target.toString());
  }
  target = new URL('/', login.return_origin || context.env.WEB_ORIGIN || context.env.APP_URL);
  try {
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(login.pkce_verifier_envelope), key, `google-login-pkce:${login.id}`);
    const tokenSet = await exchangeGoogleCode({
      code,
      verifier,
      clientId: context.env.GOOGLE_CLIENT_ID,
      clientSecret: context.env.GOOGLE_CLIENT_SECRET,
      redirectUri: googleLoginRedirectUri(context.env),
    });
    if (!hasCompleteGoogleGrant(tokenSet.scopes)) {
      await revokeGoogleToken(tokenSet.refreshToken);
      throw new Error(`必要な Google 権限が不足しています: ${missingGoogleScopes(tokenSet.scopes).join(', ')}`);
    }
    const [identity, historyId] = await Promise.all([
      fetchGoogleIdentity(tokenSet.accessToken),
      fetchGmailHistoryId(tokenSet.accessToken),
    ]);
    const timestamp = now();
    await context.env.CONTROL_DB.prepare(
      `INSERT INTO identities (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
    ).bind(crypto.randomUUID(), identity.email, identity.displayName, timestamp, timestamp).run();
    const owner = await context.env.CONTROL_DB.prepare('SELECT id FROM identities WHERE email = ?').bind(identity.email).first<{ id: string }>();
    if (!owner) throw new Error('Google identity could not be stored.');
    await ensureGoogleOrganization(context.env, owner.id, identity.email, identity.displayName);
    const automationId = crypto.randomUUID();
    const envelope = await encrypt(JSON.stringify(tokenSet), key, `google-automation:${automationId}`);
    const existing = await context.env.CONTROL_DB.prepare('SELECT id FROM google_automations WHERE identity_id = ?').bind(owner.id).first<{ id: string }>();
    const storedId = existing?.id ?? automationId;
    const storedEnvelope = existing
      ? await encrypt(JSON.stringify(tokenSet), key, `google-automation:${storedId}`)
      : envelope;
    await context.env.CONTROL_DB.prepare(
      `INSERT INTO google_automations
        (id, identity_id, google_subject, email, display_name, token_envelope, gmail_history_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET
         google_subject = excluded.google_subject, email = excluded.email, display_name = excluded.display_name,
         token_envelope = excluded.token_envelope, gmail_history_id = excluded.gmail_history_id, enabled = 1,
         last_error = NULL, updated_at = excluded.updated_at`,
    ).bind(storedId, owner.id, identity.subject, identity.email, identity.displayName, JSON.stringify(storedEnvelope), historyId, timestamp, timestamp).run();
    const sessionId = randomToken();
    await context.env.CONTROL_DB.batch([
      context.env.CONTROL_DB.prepare('DELETE FROM google_login_states WHERE id = ?').bind(login.id),
      context.env.CONTROL_DB.prepare('INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').bind(sessionId, owner.id, expiresIn(SESSION_WINDOW_MS), timestamp, timestamp),
    ]);
    context.header('Set-Cookie', cookie(SESSION_COOKIE, sessionId, requestIsSecure(context.req.raw), Math.floor(SESSION_WINDOW_MS / 1_000)));
  } catch (error) {
    target.searchParams.set('error', error instanceof Error ? error.message : 'Google ログインに失敗しました。');
  }
  return context.redirect(target.toString());
});

app.get('/api/automation', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  const automation = await context.env.CONTROL_DB.prepare('SELECT * FROM google_automations WHERE identity_id = ?')
    .bind(session.identity_id).first<GoogleAutomationRow>();
  if (!automation) return json(context, null);
  const counts = await context.env.CONTROL_DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) AS created,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN status = 'exception' THEN 1 ELSE 0 END) AS exceptions
     FROM automation_messages WHERE automation_id = ?`,
  ).bind(automation.id).first<{ created: number | null; skipped: number | null; exceptions: number | null }>();
  return json(context, {
    email: automation.email,
    displayName: automation.display_name,
    enabled: automation.enabled === 1,
    lastSyncedAt: automation.last_synced_at,
    lastError: automation.last_error,
    created: counts?.created ?? 0,
    skipped: counts?.skipped ?? 0,
    exceptions: counts?.exceptions ?? 0,
  });
});

app.post('/api/automation/run', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  try {
    return json(context, await runAutomationForIdentity(context.env, session.identity_id));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を実行できませんでした。', 409);
  }
});

app.post('/api/automation/enabled', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  const input = await context.req.json<{ enabled?: boolean }>();
  if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
  const result = await context.env.CONTROL_DB.prepare('UPDATE google_automations SET enabled = ?, updated_at = ? WHERE identity_id = ?')
    .bind(input.enabled ? 1 : 0, now(), session.identity_id).run();
  if (result.meta.changes === 0) return failure(context, 'Google 自動化が見つかりません。', 404);
  return json(context, { enabled: input.enabled });
});

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
    const input = await context.req.json<{ ownerEmail?: string }>();
    const ownerEmail = input.ownerEmail?.trim().toLowerCase();
    if (!ownerEmail || !ownerEmail.includes('@')) throw new Error('Initial Owner email is required.');
    if (ownerEmail === setup.inbox_address.toLowerCase()) throw new Error('Initial Owner must be a separate Identity from the Automation Inbox.');
    const challenge = randomToken();
    await context.env.CONTROL_DB.prepare('UPDATE organization_setups SET owner_email = ?, passkey_challenge_hash = ?, updated_at = ? WHERE id = ?')
      .bind(ownerEmail, await sha256(challenge), now(), setup.id).run();
    const options: PasskeyCreationOptions = {
      challenge,
      rp: { id: context.env.RP_ID, name: 'Mail Automation' },
      user: { id: randomToken(16), name: ownerEmail, displayName: ownerEmail },
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
    if (!setup.passkey_challenge_hash || !setup.inbox_address || !setup.google_subject || !setup.owner_email) throw new Error('Passkey registration was not started.');
    const credential = await verifyRegistration(await context.req.json(), setup.passkey_challenge_hash, context.env.RP_ID, context.env.WEB_ORIGIN);
    const organizationId = crypto.randomUUID();
    const existingOwner = await context.env.CONTROL_DB.prepare('SELECT id FROM identities WHERE email = ?').bind(setup.owner_email).first<{ id: string }>();
    const identityId = existingOwner?.id ?? crypto.randomUUID();
    const bindingName = `ORG_${organizationId.replaceAll('-', '')}`;
    const createdAt = now();
    await context.env.CONTROL_DB.batch([
      context.env.CONTROL_DB.prepare('INSERT INTO organizations (id, name, inbox_address, status, binding_name, created_at, updated_at) VALUES (?, ?, ?, \'provisioning\', ?, ?, ?)').bind(organizationId, setup.name, setup.inbox_address, bindingName, createdAt, createdAt),
      context.env.CONTROL_DB.prepare('INSERT OR IGNORE INTO identities (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(identityId, setup.owner_email, setup.owner_email, createdAt, createdAt),
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
  const keys = await context.env.CONTROL_DB.prepare('SELECT credential_id FROM passkeys WHERE identity_id = ? AND revoked_at IS NULL').bind(identity.id).all<{ credential_id: string }>();
  context.header('Set-Cookie', cookie(LOGIN_COOKIE, challengeId, requestIsSecure(context.req.raw), Math.floor(PASSKEY_WINDOW_MS / 1_000)));
  return json(context, { challenge, rpId: context.env.RP_ID, timeout: PASSKEY_WINDOW_MS, userVerification: 'required', allowCredentials: keys.results.map((key) => ({ type: 'public-key', id: key.credential_id })) });
});

app.post('/api/auth/passkey/verify', async (context) => {
  const challengeId = requestCookie(context.req.header('Cookie'), LOGIN_COOKIE);
  if (!challengeId) return failure(context, 'Login challenge is missing.', 401);
  const challenge = await context.env.CONTROL_DB.prepare('SELECT * FROM passkey_challenges WHERE id = ? AND expires_at > ?').bind(challengeId, now()).first<{ id: string; identity_id: string; challenge_hash: string }>();
  if (!challenge) return failure(context, 'Login challenge expired.', 401);
  const response = await context.req.json<AuthenticationResponse>();
  const passkey = await context.env.CONTROL_DB.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND identity_id = ? AND revoked_at IS NULL').bind(response.rawId, challenge.identity_id).first<PasskeyRow>();
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
  await ensureGoogleOrganization(context.env, session.identity_id, session.email, session.display_name);
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

app.get('/api/organizations/:organizationId/connections', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    const rows = access.database
      ? await access.database.prepare("SELECT * FROM connections WHERE kind IN ('line', 'ai') AND status = 'active'").all<ConnectionRow>()
      : await context.env.CONTROL_DB.prepare("SELECT id, kind, label, credential, status FROM organization_connections WHERE organization_id = ? AND status = 'active'")
        .bind(organizationId).all<OrganizationConnectionRow>();
    const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
      .bind(organizationId).first<{ master_key_version: string; wrapped_key_envelope: string }>();
    if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
    const deploymentKey = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
      deploymentKey,
      organizationId,
    );
    const line = rows.results.find((row) => row.kind === 'line');
    const ai = rows.results.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(line ?? null, organizationKey, organizationId, 'line'),
      connectionCredential(ai ?? null, organizationKey, organizationId, 'ai'),
    ]);
    return json(context, { organizationId, organizationName: access.organization.name, ...connectionView(lineCredential, aiCredential) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を取得できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.put('/api/organizations/:organizationId/connections', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, '接続設定を変更できる権限がありません。', 403);
    const input = await context.req.json<OrganizationConnectionInput>();
    const rows = access.database
      ? await access.database.prepare("SELECT * FROM connections WHERE kind IN ('line', 'ai') AND status = 'active'").all<ConnectionRow>()
      : await context.env.CONTROL_DB.prepare("SELECT id, organization_id, kind, label, credential, status FROM organization_connections WHERE organization_id = ? AND status = 'active'")
        .bind(organizationId).all<OrganizationConnectionRow>();
    const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
      .bind(organizationId).first<{ master_key_version: string; wrapped_key_envelope: string }>();
    if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
    const deploymentKey = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
      deploymentKey,
      organizationId,
    );
    const existingLine = rows.results.find((row) => row.kind === 'line');
    const existingAi = rows.results.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(existingLine ?? null, organizationKey, organizationId, 'line'),
      connectionCredential(existingAi ?? null, organizationKey, organizationId, 'ai'),
    ]);
    const nextLine: OrganizationCredential = { ...lineCredential, ...input.line };
    const nextAi: OrganizationCredential = { ...aiCredential, ...input.ai };
    const updatingLine = Boolean(input.line?.channelAccessToken || input.line?.channelSecret);
    if (updatingLine && (!nextLine.channelAccessToken || !nextLine.channelSecret)) return failure(context, 'LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    if (nextAi.provider !== 'Google Gemini API' || !nextAi.apiKey || !nextAi.model) return failure(context, 'Gemini API キーを入力してください。');
    const timestamp = now();
    const lineEnvelope = await encrypt(JSON.stringify(nextLine), organizationKey, connectionContext(organizationId, 'line'));
    const aiEnvelope = await encrypt(JSON.stringify(nextAi), organizationKey, connectionContext(organizationId, 'ai'));
    const save = async (existing: ConnectionRow | undefined, kind: 'line' | 'ai', label: string, credential: string): Promise<void> => {
      if (existing) {
        if (access.database) {
          await access.database.prepare('UPDATE connections SET label = ?, credential = ?, status = \'active\', updated_at = ? WHERE id = ?')
            .bind(label, credential, timestamp, existing.id).run();
        } else {
          await context.env.CONTROL_DB.prepare('UPDATE organization_connections SET label = ?, credential = ?, status = \'active\', updated_at = ? WHERE id = ?')
            .bind(label, credential, timestamp, existing.id).run();
        }
        return;
      }
      if (access.database) {
        await access.database.prepare('INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'active\', ?, ?)')
          .bind(crypto.randomUUID(), kind, label, credential, timestamp, timestamp).run();
      } else {
        await context.env.CONTROL_DB.prepare('INSERT INTO organization_connections (id, organization_id, kind, label, credential, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'active\', ?, ?)')
          .bind(crypto.randomUUID(), organizationId, kind, label, credential, timestamp, timestamp).run();
      }
    };
    await Promise.all([
      save(existingLine, 'line', 'LINE Messaging API', JSON.stringify(lineEnvelope)),
      save(existingAi, 'ai', `${nextAi.provider} AI`, JSON.stringify(aiEnvelope)),
    ]);
    return json(context, { organizationId, organizationName: access.organization.name, ...connectionView(nextLine, nextAi) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '接続設定を保存できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

app.post('/api/organizations/:organizationId/connections/gemini-oauth', async (context) => {
  return failure(context, 'Google Cloud OAuth 接続は廃止されました。Google AI Studio の Gemini API キーを設定してください。', 410);
  /*
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, '接続設定を変更できる権限がありません。', 403);
    const invalid = configurationError(context.env);
    if (invalid) return failure(context, invalid, 503);
    const input = await context.req.json<GeminiOAuthInput>();
    const projectId = input.projectId?.trim() ?? '';
    if (!validProjectId(projectId)) return failure(context, 'Gemini を利用する GCP プロジェクト ID を入力してください。');
    const id = crypto.randomUUID();
    const state = randomToken();
    const pkce = await createPkce();
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const [verifierEnvelope, configurationEnvelope] = await Promise.all([
      encrypt(pkce.verifier, key, `gemini-oauth-pkce:${id}`),
      encrypt(JSON.stringify({ projectId }), key, `gemini-oauth-configuration:${id}`),
    ]);
    await context.env.CONTROL_DB.prepare(
      'INSERT INTO gemini_oauth_states (id, organization_id, identity_id, state_hash, pkce_verifier_envelope, configuration_envelope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, organizationId, access.session.identity_id, await sha256(state), JSON.stringify(verifierEnvelope), JSON.stringify(configurationEnvelope), expiresIn(GEMINI_OAUTH_WINDOW_MS), now()).run();
    return json(context, {
      authorizationUrl: googleAuthorizationUrl({
        clientId: context.env.GOOGLE_CLIENT_ID,
        redirectUri: geminiOAuthRedirectUri(context.env),
        state,
        challenge: pkce.challenge,
        scopes: GEMINI_AGENT_PLATFORM_SCOPES,
      }),
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini Enterprise Agent Platform OAuth を開始できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
  */
});

app.get('/oauth/gemini/callback', async (context) => {
  const discontinuedTarget = new URL('/', context.env.WEB_ORIGIN || context.env.APP_URL);
  discontinuedTarget.searchParams.set('error', 'Google Cloud OAuth 接続は廃止されました。Google AI Studio の Gemini API キーを設定してください。');
  return context.redirect(discontinuedTarget.toString());
  /*
  const target = new URL('/', context.env.WEB_ORIGIN || context.env.APP_URL);
  const code = context.req.query('code');
  const state = context.req.query('state');
  if (!code || !state) {
    target.searchParams.set('error', 'Gemini Enterprise Agent Platform の Google Cloud 認可がキャンセルされました。');
    return context.redirect(target.toString());
  }
  const grant = await context.env.CONTROL_DB.prepare(
    'SELECT * FROM gemini_oauth_states WHERE state_hash = ? AND expires_at > ?',
  ).bind(await sha256(state), now()).first<GeminiOAuthStateRow>();
  if (!grant) {
    target.searchParams.set('error', 'Gemini Enterprise Agent Platform OAuth の有効期限が切れました。設定画面からもう一度接続してください。');
    return context.redirect(target.toString());
  }
  try {
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const [verifier, configurationText] = await Promise.all([
      decrypt(JSON.parse(grant.pkce_verifier_envelope), key, `gemini-oauth-pkce:${grant.id}`),
      decrypt(JSON.parse(grant.configuration_envelope), key, `gemini-oauth-configuration:${grant.id}`),
    ]);
    const configuration = JSON.parse(configurationText) as Required<GeminiOAuthInput>;
    const tokenSet = await exchangeGoogleCode({
      code,
      verifier,
      clientId: context.env.GOOGLE_CLIENT_ID,
      clientSecret: context.env.GOOGLE_CLIENT_SECRET,
      redirectUri: geminiOAuthRedirectUri(context.env),
    });
    if (!tokenSet.scopes.includes(GEMINI_AGENT_PLATFORM_SCOPES[0])) throw new Error('Gemini Enterprise Agent Platform に必要な cloud-platform 権限が承認されませんでした。');
    const membership = await context.env.CONTROL_DB.prepare(
      `SELECT m.role, o.id, o.status, o.binding_name
       FROM members m JOIN organizations o ON o.id = m.organization_id
       WHERE m.identity_id = ? AND m.organization_id = ? AND m.state = 'active'`,
    ).bind(grant.identity_id, grant.organization_id).first<{ role: string; id: string; status: string; binding_name: string }>();
    if (!membership || membership.status !== 'active' || (membership.role !== 'owner' && membership.role !== 'admin')) throw new Error('この組織の Gemini Enterprise Agent Platform 接続を保存する権限がありません。');
    const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
      .bind(grant.organization_id).first<{ master_key_version: string; wrapped_key_envelope: string }>();
    if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
      key,
      grant.organization_id,
    );
    const credential: OrganizationCredential = {
      provider: 'Google Gemini Enterprise Agent Platform', authMode: 'oauth', model: DEFAULT_GEMINI_MODEL,
      gcpProjectId: configuration.projectId, gcpLocation: 'global',
      oauthAccessToken: tokenSet.accessToken, oauthRefreshToken: tokenSet.refreshToken,
      oauthExpiresAt: tokenSet.expiresAt, oauthScopes: tokenSet.scopes.join(' '),
    };
    const envelope = JSON.stringify(await encrypt(JSON.stringify(credential), organizationKey, connectionContext(grant.organization_id, 'ai')));
    const timestamp = now();
    const database = organizationDatabase(context.env, membership.binding_name);
    const existing = database
      ? await database.prepare("SELECT * FROM connections WHERE kind = 'ai' AND status = 'active' LIMIT 1").first<ConnectionRow>()
      : await context.env.CONTROL_DB.prepare("SELECT id, organization_id, kind, label, credential, status FROM organization_connections WHERE organization_id = ? AND kind = 'ai' AND status = 'active' LIMIT 1")
        .bind(grant.organization_id).first<OrganizationConnectionRow>();
    if (existing) {
      if (database) await database.prepare("UPDATE connections SET label = ?, credential = ?, status = 'active', updated_at = ? WHERE id = ?")
        .bind('Google Gemini Enterprise Agent Platform (OAuth)', envelope, timestamp, existing.id).run();
      else await context.env.CONTROL_DB.prepare("UPDATE organization_connections SET label = ?, credential = ?, status = 'active', updated_at = ? WHERE id = ?")
        .bind('Google Gemini Enterprise Agent Platform (OAuth)', envelope, timestamp, existing.id).run();
    } else if (database) {
      await database.prepare("INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at) VALUES (?, 'ai', ?, ?, 'active', ?, ?)")
        .bind(crypto.randomUUID(), 'Google Gemini Enterprise Agent Platform (OAuth)', envelope, timestamp, timestamp).run();
    } else {
      await context.env.CONTROL_DB.prepare("INSERT INTO organization_connections (id, organization_id, kind, label, credential, status, created_at, updated_at) VALUES (?, ?, 'ai', ?, ?, 'active', ?, ?)")
        .bind(crypto.randomUUID(), grant.organization_id, 'Google Gemini Enterprise Agent Platform (OAuth)', envelope, timestamp, timestamp).run();
    }
    await context.env.CONTROL_DB.prepare('DELETE FROM gemini_oauth_states WHERE id = ?').bind(grant.id).run();
    target.searchParams.set('gemini', 'connected');
  } catch (error) {
    await context.env.CONTROL_DB.prepare('DELETE FROM gemini_oauth_states WHERE id = ?').bind(grant.id).run();
    target.searchParams.set('error', error instanceof Error ? error.message : 'Gemini Enterprise Agent Platform OAuth 接続に失敗しました。');
  }
  return context.redirect(target.toString());
  */
});

app.post('/api/organizations/:organizationId/connections/gemini/test', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    const input = await context.req.json<{ prompt?: string }>();
    const prompt = input.prompt?.trim() ?? '';
    if (!prompt || prompt.length > 10_000) return failure(context, 'テスト用の質問は 1〜10,000 文字で入力してください。');
    const existing = access.database
      ? await access.database.prepare("SELECT * FROM connections WHERE kind = 'ai' AND status = 'active' LIMIT 1").first<ConnectionRow>()
      : await context.env.CONTROL_DB.prepare("SELECT id, organization_id, kind, label, credential, status FROM organization_connections WHERE organization_id = ? AND kind = 'ai' AND status = 'active' LIMIT 1")
        .bind(organizationId).first<OrganizationConnectionRow>();
    if (!existing) return failure(context, 'Gemini Enterprise Agent Platform の OAuth 接続がありません。', 409);
    const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
      .bind(organizationId).first<{ master_key_version: string; wrapped_key_envelope: string }>();
    if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
    const deploymentKey = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
      deploymentKey,
      organizationId,
    );
    const credential = await connectionCredential(existing, organizationKey, organizationId, 'ai');
    if (credential.provider !== 'Google Gemini API' || !credential.apiKey) return failure(context, 'Gemini API キーを設定してください。', 409);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(credential.model || DEFAULT_GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': credential.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });
    const body = await response.json() as GeminiGenerateContentResponse;
    if (!response.ok) throw new Error(body.error?.message ?? 'Gemini API が応答しませんでした。');
    const text = generatedText(body);
    if (!text) throw new Error('Gemini API からテキスト応答を受け取れませんでした。');
    return json(context, { text, model: credential.model || DEFAULT_GEMINI_MODEL });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini API の接続テストに失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.get('/api/organizations/:organizationId/lists', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare(
      'SELECT id, kind, name, description, created_at, updated_at FROM lists ORDER BY name',
    ).all<{ id: string; kind: string; name: string; description: string; created_at: string; updated_at: string }>();
    return json(context, rows.results.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed Lists could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/lists', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Typed Lists can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ kind?: string; name?: string; description?: string }>();
    const kind = input.kind?.trim();
    const name = input.name?.trim();
    if (!kind || !['source', 'label', 'calendar_recipient', 'line_destination'].includes(kind)) return failure(context, 'Unsupported Typed List kind.');
    if (!name) return failure(context, 'Typed List name is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const description = input.description?.trim() ?? '';
    await access.database.prepare(
      'INSERT INTO lists (id, organization_id, kind, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, access.organization.id, kind, name, description, timestamp, timestamp).run();
    return json(context, {
      id,
      organizationId: access.organization.id,
      kind,
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed List could not be created.', 409);
  }
});

app.post('/api/organizations/:organizationId/lists/:listId/items', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'List Items can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ value?: string; label?: string }>();
    const value = input.value?.trim();
    if (!value) return failure(context, 'List Item value is required.');
    const id = crypto.randomUUID();
    await access.database.prepare('INSERT INTO list_items (id, list_id, value, label, enabled) VALUES (?, ?, ?, ?, 1)')
      .bind(id, context.req.param('listId'), value, input.label?.trim() ?? '').run();
    return json(context, { id, listId: context.req.param('listId'), value, label: input.label?.trim() ?? '', enabled: true }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/lists/:listId/items/:itemId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'List Items can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const result = await access.database.prepare('UPDATE list_items SET enabled = ? WHERE id = ? AND list_id = ?')
      .bind(input.enabled ? 1 : 0, context.req.param('itemId'), context.req.param('listId')).run();
    if (result.meta.changes === 0) return failure(context, 'List Item was not found.', 404);
    return json(context, { id: context.req.param('itemId'), enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare('SELECT id, name, status, selection_policy, routing_policy, priority, created_at, updated_at FROM rules ORDER BY priority DESC, name')
      .all<{ id: string; name: string; status: string; selection_policy: string; routing_policy: string; priority: number; created_at: string; updated_at: string }>();
    return json(context, rows.results.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      state: row.status,
      selectionPolicy: JSON.parse(row.selection_policy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routing_policy) as Record<string, unknown>,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rules could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Rules can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; state?: string; selectionPolicy?: Record<string, unknown>; routingPolicy?: Record<string, unknown>; priority?: number }>();
    const name = input.name?.trim();
    const state = input.state ?? 'draft';
    if (!name) return failure(context, 'Rule name is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Rule State.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(input.routingPolicy ?? {});
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    await access.database.prepare(
      'INSERT INTO rules (id, organization_id, name, status, selection_policy, routing_policy, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, access.organization.id, name, state, selectionPolicy, routingPolicy, priority, timestamp, timestamp).run();
    await access.database.prepare(
      'INSERT INTO rule_revisions (id, rule_id, revision, selection_policy, routing_policy, created_at) VALUES (?, ?, 1, ?, ?, ?)',
    ).bind(crypto.randomUUID(), id, selectionPolicy, routingPolicy, timestamp).run();
    return json(context, { id, organizationId: access.organization.id, name, state, selectionPolicy: input.selectionPolicy ?? {}, routingPolicy: input.routingPolicy ?? {}, priority, createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/rules/:ruleId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'Rules can only be changed by an Owner or Admin.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ state?: string }>();
    if (!input.state || !['draft', 'active', 'suspended', 'archived'].includes(input.state)) return failure(context, 'Unsupported Rule State.');
    const result = await access.database.prepare('UPDATE rules SET status = ?, updated_at = ? WHERE id = ?')
      .bind(input.state, now(), context.req.param('ruleId')).run();
    if (result.meta.changes === 0) return failure(context, 'Rule was not found.', 404);
    return json(context, { id: context.req.param('ruleId'), state: input.state });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/recipients', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare('SELECT id, name, email, state, tags, created_at, updated_at FROM recipient_profiles ORDER BY name')
      .all<{ id: string; name: string; email: string; state: string; tags: string; created_at: string; updated_at: string }>();
    return json(context, rows.results.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      email: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.email),
      state: row.state,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profiles could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/recipients/export', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare("SELECT name, email FROM recipient_profiles WHERE state = 'active' ORDER BY name").all<{ name: string; email: string }>();
    return new Response(exportRecipientCsv(rows.results), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="recipients.csv"' } });
  } catch (error) { return failure(context, error instanceof Error ? error.message : 'Recipient export could not be created.', 403); }
});

app.post('/api/organizations/:organizationId/recipients', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Profiles can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string }>();
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase();
    if (!name || !email || !email.includes('@')) return failure(context, 'Recipient name and a valid email address are required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    await access.database.prepare(
      "INSERT INTO recipient_profiles (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', '[]', ?, ?)",
    ).bind(id, access.organization.id, name, email, timestamp, timestamp).run();
    return json(context, { id, organizationId: access.organization.id, name, email, state: 'active', tags: [], createdAt: timestamp, updatedAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profile could not be created.', 409);
  }
});

app.patch('/api/organizations/:organizationId/recipients/:recipientId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Profiles can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ name?: string; email?: string; tags?: unknown; state?: string }>();
    const updates: Array<{ column: string; value: string }> = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return failure(context, 'Recipient name cannot be empty.');
      updates.push({ column: 'name', value: name });
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (!email.includes('@')) return failure(context, 'A valid Recipient email address is required.');
      updates.push({ column: 'email', value: email });
    }
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) return failure(context, 'Recipient tags must be non-empty strings.');
      tags = input.tags.map((tag) => tag.trim());
      updates.push({ column: 'tags', value: JSON.stringify(tags) });
    }
    if (input.state !== undefined) {
      if (!['active', 'inactive'].includes(input.state)) return failure(context, 'Unsupported Recipient state.');
      updates.push({ column: 'state', value: input.state });
    }
    if (!updates.length) return failure(context, 'At least one Recipient field is required.');
    const result = await access.database.prepare(`UPDATE recipient_profiles SET ${updates.map((update) => `${update.column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...updates.map((update) => update.value), now(), context.req.param('recipientId')).run();
    if (result.meta.changes === 0) return failure(context, 'Recipient Profile was not found.', 404);
    return json(context, {
      id: context.req.param('recipientId'),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      ...(tags === undefined ? {} : { tags }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profile could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/:recipientId/line-links', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient Links can only be issued by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const token = randomToken(24);
    const timestamp = now();
    const expiresAt = expiresIn(RECIPIENT_LINK_WINDOW_MS);
    await access.database.prepare('UPDATE recipient_link_tokens SET used_at = ? WHERE recipient_profile_id = ? AND used_at IS NULL')
      .bind(timestamp, context.req.param('recipientId')).run();
    await access.database.prepare(
      'INSERT INTO recipient_link_tokens (token, recipient_profile_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    ).bind(token, context.req.param('recipientId'), expiresAt, timestamp).run();
    return json(context, {
      recipientProfileId: context.req.param('recipientId'),
      token,
      expiresAt,
      linkUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.organization.id)}/line-links/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Link could not be issued.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/import/preview', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient imports can only be previewed by an Owner, Admin, or Operator.', 403);
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    return json(context, previewRecipientCsv(input.csv));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient import could not be previewed.', 409);
  }
});

app.post('/api/organizations/:organizationId/recipients/import', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient imports can only be confirmed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ csv?: string }>();
    if (typeof input.csv !== 'string') return failure(context, 'CSV content is required.');
    const preview = previewRecipientCsv(input.csv);
    const timestamp = now();
    const writes = await Promise.all(preview.accepted.map((recipient) => access.database!.prepare(
      "INSERT OR IGNORE INTO recipient_profiles (id, organization_id, name, email, state, tags, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', '[]', ?, ?)",
    ).bind(crypto.randomUUID(), access.organization.id, recipient.name, recipient.email, timestamp, timestamp).run()));
    const imported = writes.reduce((count, result) => count + result.meta.changes, 0);
    return json(context, { imported, duplicates: preview.duplicates, invalid: preview.invalid }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient import could not be completed.', 409);
  }
});

app.get('/api/organizations/:organizationId/dashboard', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const [rules, events, jobs, exceptions, connection] = await Promise.all([
      access.database.prepare("SELECT COUNT(*) AS count FROM rules WHERE status = 'active'").first<{ count: number }>(),
      access.database.prepare("SELECT COUNT(*) AS count FROM events WHERE status = 'scheduled' AND starts_at >= ?").bind(now()).first<{ count: number }>(),
      access.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('pending', 'running')").first<{ count: number }>(),
      access.database.prepare("SELECT COUNT(*) AS count FROM exceptions WHERE state = 'open'").first<{ count: number }>(),
      access.database.prepare("SELECT MAX(updated_at) AS last_synced_at FROM google_connections WHERE kind = 'automation_inbox'").first<{ last_synced_at: string | null }>(),
    ]);
    return json(context, {
      activeRules: rules?.count ?? 0,
      upcomingEvents: events?.count ?? 0,
      pendingJobs: jobs?.count ?? 0,
      exceptions: exceptions?.count ?? 0,
      lastSyncedAt: connection?.last_synced_at ?? null,
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Dashboard could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/members/:identityId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner') return failure(context, 'Only an Owner can change member roles.', 403);
    const input = await context.req.json<{ role?: string; state?: string }>();
    if (input.role !== undefined && !['owner', 'admin', 'operator', 'viewer'].includes(input.role)) return failure(context, 'Unsupported member role.');
    if (input.state !== undefined && !['active', 'suspended'].includes(input.state)) return failure(context, 'Unsupported member state.');
    if (input.role === undefined && input.state === undefined) return failure(context, 'A member role or state is required.');
    const updates: Array<{ column: string; value: string }> = [];
    if (input.role !== undefined) updates.push({ column: 'role', value: input.role });
    if (input.state !== undefined) updates.push({ column: 'state', value: input.state });
    const result = await context.env.CONTROL_DB.prepare(`UPDATE members SET ${updates.map((update) => `${update.column} = ?`).join(', ')}, updated_at = ? WHERE organization_id = ? AND identity_id = ?`)
      .bind(...updates.map((update) => update.value), now(), access.organization.id, context.req.param('identityId')).run();
    if (result.meta.changes === 0) return failure(context, 'Member was not found.', 404);
    return json(context, { identityId: context.req.param('identityId'), ...(input.role === undefined ? {} : { role: input.role }), ...(input.state === undefined ? {} : { state: input.state }) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/passkeys', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner') return failure(context, 'Only an Owner can view passkeys.', 403);
    const rows = await context.env.CONTROL_DB.prepare(
      `SELECT p.id, p.identity_id, i.email, p.created_at, p.last_used_at
       FROM passkeys p JOIN members m ON m.identity_id = p.identity_id JOIN identities i ON i.id = p.identity_id
       WHERE m.organization_id = ? AND p.revoked_at IS NULL ORDER BY p.created_at DESC`,
    ).bind(access.organization.id).all<{ id: string; identity_id: string; email: string; created_at: string; last_used_at: string | null }>();
    return json(context, rows.results.map((row) => ({ id: row.id, identityId: row.identity_id, email: row.email, createdAt: row.created_at, lastUsedAt: row.last_used_at })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Passkeys could not be loaded.', 403);
  }
});

app.delete('/api/organizations/:organizationId/passkeys/:passkeyId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner') return failure(context, 'Only an Owner can revoke passkeys.', 403);
    const result = await context.env.CONTROL_DB.prepare(
      `UPDATE passkeys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
       AND identity_id IN (SELECT identity_id FROM members WHERE organization_id = ?)`,
    ).bind(now(), context.req.param('passkeyId'), access.organization.id).run();
    if (result.meta.changes === 0) return failure(context, 'Passkey was not found or already revoked.', 404);
    return json(context, { id: context.req.param('passkeyId'), state: 'revoked' });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Passkey could not be revoked.', 409);
  }
});

app.post('/api/organizations/:organizationId/recovery-requests', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'owner') return failure(context, 'Only an Owner can request recovery.', 403);
    const input = await context.req.json<{ idempotencyKey?: string }>();
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) return failure(context, 'A recovery receipt idempotency key is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    await context.env.CONTROL_DB.prepare(
      "INSERT INTO recovery_requests (id, organization_id, idempotency_key, state, requested_by_identity_id, created_at) VALUES (?, ?, ?, 'requested', ?, ?)",
    ).bind(id, access.organization.id, idempotencyKey, access.session.identity_id, timestamp).run();
    return json(context, { id, organizationId: access.organization.id, idempotencyKey, state: 'requested', createdAt: timestamp }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery request could not be created.', 409);
  }
});

app.post('/api/organizations/:organizationId/recovery-requests/:requestId/execute', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (access.role !== 'operator') return failure(context, 'Only an Operator can execute an Owner recovery request.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const request = await context.env.CONTROL_DB.prepare(
      "SELECT id, idempotency_key FROM recovery_requests WHERE id = ? AND organization_id = ? AND state = 'requested'",
    ).bind(context.req.param('requestId'), access.organization.id).first<{ id: string; idempotency_key: string }>();
    if (!request) return failure(context, 'Recovery request was not found or is no longer pending.', 404);
    const claimed = await context.env.CONTROL_DB.prepare("UPDATE recovery_requests SET state = 'executing', executed_by_identity_id = ? WHERE id = ? AND state = 'requested'")
      .bind(access.session.identity_id, request.id).run();
    if (claimed.meta.changes === 0) return failure(context, 'Recovery request is already being executed.', 409);
    try {
      const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
        .bind(access.organization.id).first<{ master_key_version: string; wrapped_key_envelope: string }>();
      if (!keyRecord) throw new Error('Organization encryption key is missing.');
      const organizationKey = await unwrapOrganizationKey(
        { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
        await masterKey(context.env.CREDENTIAL_MASTER_KEY), access.organization.id,
      );
      const receipt = await readRecoveryReceipt({ bucket: context.env.RECOVERY_RECEIPTS, organizationKey, organizationId: access.organization.id, idempotencyKey: request.idempotency_key });
      if (!receipt) throw new Error('The requested recovery receipt no longer exists.');
      await restoreDeliveryRecordFromReceipt(access.database, receipt);
      await context.env.CONTROL_DB.prepare("UPDATE recovery_requests SET state = 'completed', executed_at = ?, error_message = NULL WHERE id = ?")
        .bind(now(), request.id).run();
      return json(context, { id: request.id, state: 'completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery execution failed.';
      await context.env.CONTROL_DB.prepare("UPDATE recovery_requests SET state = 'failed', error_message = ?, executed_at = ? WHERE id = ?")
        .bind(message, now(), request.id).run();
      return failure(context, message, 409);
    }
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery execution could not be started.', 409);
  }
});

app.post('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const organization = await context.env.CONTROL_DB.prepare(
      "SELECT id, status, binding_name FROM organizations WHERE id = ? AND status = 'active'",
    ).bind(organizationId).first<{ id: string; status: string; binding_name: string }>();
    const database = organization ? organizationDatabase(context.env, organization.binding_name) : null;
    if (!database) return failure(context, 'Attendance link was not found.', 404);
    const input = await context.req.json<{ eventId?: string; status?: string; comment?: string }>();
    if (!input.eventId || !['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) return failure(context, 'A response status is required.');
    const comment = input.comment?.trim() ?? '';
    if (comment.length > 1_000) return failure(context, 'Attendance comment is too long.');
    const link = await database.prepare(
      `SELECT a.event_id, a.event_id AS link_event_id, a.revoked_at, e.attendance_deadline
       FROM attendance a JOIN events e ON e.id = a.event_id WHERE a.token = ?`,
    ).bind(context.req.param('token')).first<{ event_id: string; link_event_id: string; revoked_at: string | null; attendance_deadline: string | null }>();
    if (!link || !link.attendance_deadline || !canUpdateAttendance({
      eventId: input.eventId,
      linkEventId: link.link_event_id,
      revokedAt: link.revoked_at,
      deadline: link.attendance_deadline,
      now: now(),
    })) return failure(context, 'Attendance link is no longer available.', 410);
    await database.prepare('UPDATE attendance SET status = ?, comment = ?, updated_at = ? WHERE token = ? AND event_id = ?')
      .bind(input.status, comment, now(), context.req.param('token'), input.eventId).run();
    return json(context, { eventId: input.eventId, status: input.status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance response could not be saved.', 409);
  }
});

app.get('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  const organization = await context.env.CONTROL_DB.prepare("SELECT binding_name FROM organizations WHERE id = ? AND status = 'active'").bind(context.req.param('organizationId')).first<{ binding_name: string }>();
  const database = organization ? organizationDatabase(context.env, organization.binding_name) : null;
  if (!database) return failure(context, 'Attendance link was not found.', 404);
  const row = await database.prepare('SELECT event_id, status, comment FROM attendance WHERE token = ? AND revoked_at IS NULL').bind(context.req.param('token')).first<{ event_id: string; status: string; comment: string }>();
  if (!row) return failure(context, 'Attendance link was not found.', 404);
  return json(context, { eventId: row.event_id, status: row.status, comment: row.comment });
});

app.patch('/api/organizations/:organizationId/events/:eventId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Events can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ title?: string; startsAt?: string; endsAt?: string; location?: string; description?: string; status?: string; reason?: string }>();
    const candidates: Array<{ key: string; column: string; value: string | undefined }> = [
      { key: 'title', column: 'title', value: input.title?.trim() },
      { key: 'startsAt', column: 'starts_at', value: input.startsAt?.trim() },
      { key: 'endsAt', column: 'ends_at', value: input.endsAt?.trim() },
      { key: 'location', column: 'location', value: input.location?.trim() },
      { key: 'description', column: 'description', value: input.description?.trim() },
      { key: 'status', column: 'status', value: input.status?.trim() },
    ];
    const updates = candidates.filter((candidate) => candidate.value !== undefined);
    if (!updates.length || updates.some((candidate) => candidate.value === '')) return failure(context, 'At least one non-empty Event field is required.');
    const status = updates.find((candidate) => candidate.key === 'status')?.value;
    if (status && !['draft', 'scheduled', 'cancelled', 'exception'].includes(status)) return failure(context, 'Unsupported Event status.');
    const timestamp = now();
    const result = await access.database.prepare(
      `UPDATE events SET ${updates.map((candidate) => `${candidate.column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ).bind(...updates.map((candidate) => candidate.value), timestamp, context.req.param('eventId')).run();
    if (result.meta.changes === 0) return failure(context, 'Event was not found.', 404);
    const changeSet = Object.fromEntries(updates.map((candidate) => [candidate.key, candidate.value]));
    await access.database.prepare(
      'INSERT INTO event_overrides (id, event_id, actor_identity_id, changes_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), context.req.param('eventId'), access.session.identity_id, JSON.stringify(changeSet), input.reason?.trim() ?? '', timestamp).run();
    return json(context, { id: context.req.param('eventId'), updatedFields: updates.map((candidate) => candidate.key) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Event could not be updated.', 409);
  }
});

app.post('/api/organizations/:organizationId/events/:eventId/attendance-links', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Attendance links can only be issued by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ recipientItemId?: string }>();
    if (!input.recipientItemId?.trim()) return failure(context, 'A Recipient is required.');
    const eventId = context.req.param('eventId');
    const token = randomToken(32);
    const timestamp = now();
    await access.database.prepare(
      `INSERT INTO attendance (event_id, recipient_item_id, status, comment, token, revoked_at, updated_at)
       VALUES (?, ?, 'unanswered', '', ?, NULL, ?)
       ON CONFLICT(event_id, recipient_item_id) DO UPDATE SET token = excluded.token, status = 'unanswered', comment = '', revoked_at = NULL, updated_at = excluded.updated_at`,
    ).bind(eventId, input.recipientItemId.trim(), token, timestamp).run();
    return json(context, {
      eventId,
      recipientItemId: input.recipientItemId.trim(),
      token,
      attendanceUrl: `${context.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(access.organization.id)}/attendance/${encodeURIComponent(token)}`,
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance link could not be issued.', 409);
  }
});

app.post('/api/organizations/:organizationId/events/:eventId/recipient-snapshots', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Recipient snapshots can only be created by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ recipientProfileIds?: unknown }>();
    if (!Array.isArray(input.recipientProfileIds) || !input.recipientProfileIds.length || input.recipientProfileIds.some((id) => typeof id !== 'string' || !id.trim())) return failure(context, 'At least one Recipient Profile is required.');
    const recipientProfileIds = [...new Set(input.recipientProfileIds.map((id) => id.trim()))];
    const recipients = await Promise.all(recipientProfileIds.map((id) => access.database!.prepare(
      "SELECT id, name, email, state FROM recipient_profiles WHERE id = ? AND state = 'active'",
    ).bind(id).first<{ id: string; name: string; email: string; state: string }>()));
    if (recipients.some((recipient) => !recipient)) return failure(context, 'One or more active Recipient Profiles were not found.', 404);
    const timestamp = now();
    await Promise.all(recipients.map((recipient) => access.database!.prepare(
      'INSERT OR IGNORE INTO event_recipients (event_id, recipient_profile_id, name_snapshot, email_snapshot, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(context.req.param('eventId'), recipient!.id, recipient!.name, recipient!.email, timestamp).run()));
    return json(context, { eventId: context.req.param('eventId'), snapshotted: recipients.length }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient snapshots could not be created.', 409);
  }
});

app.get('/api/organizations/:organizationId/audit/deliveries', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare(
      'SELECT id, event_id, channel, destination, outcome, external_id, created_at FROM deliveries ORDER BY created_at DESC LIMIT 100',
    ).all<{ id: string; event_id: string | null; channel: string; destination: string; outcome: string; external_id: string | null; created_at: string }>();
    return json(context, rows.results.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      channel: row.channel,
      destination: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.destination),
      outcome: row.outcome,
      externalId: row.external_id,
      createdAt: row.created_at,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Delivery audit could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/operations/exceptions', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await access.database.prepare(
      'SELECT id, source_message_id, code, message, state, created_at, resolved_at FROM exceptions ORDER BY created_at DESC LIMIT 100',
    ).all<{ id: string; source_message_id: string | null; code: string; message: string; state: string; created_at: string; resolved_at: string | null }>();
    return json(context, rows.results.map((row) => ({
      id: row.id, sourceMessageId: row.source_message_id, code: row.code, message: row.message, state: row.state, createdAt: row.created_at, resolvedAt: row.resolved_at,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exceptions could not be loaded.', 403);
  }
});

app.patch('/api/organizations/:organizationId/operations/exceptions/:exceptionId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Only an Owner, Admin, or Operator can change Exceptions.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ action?: string }>();
    if (input.action === 'resolve') {
      const result = await access.database.prepare("UPDATE exceptions SET state = 'resolved', resolved_at = ? WHERE id = ? AND state != 'resolved'")
        .bind(now(), context.req.param('exceptionId')).run();
      if (result.meta.changes === 0) return failure(context, 'Exception was not found or already resolved.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'resolved' });
    }
    if (input.action === 'retry') {
      const result = await access.database.prepare("UPDATE exceptions SET state = 'retry_requested', resolved_at = NULL WHERE id = ?")
        .bind(context.req.param('exceptionId')).run();
      if (result.meta.changes === 0) return failure(context, 'Exception was not found.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'retry_requested' });
    }
    return failure(context, 'Unsupported Exception action.');
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Exception could not be updated.', 409);
  }
});

app.post('/api/public/organizations/:organizationId/line/webhook', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const organization = await context.env.CONTROL_DB.prepare(
      "SELECT id, status, binding_name FROM organizations WHERE id = ? AND status = 'active'",
    ).bind(organizationId).first<{ id: string; status: string; binding_name: string }>();
    const database = organization ? organizationDatabase(context.env, organization.binding_name) : null;
    if (!database) return failure(context, 'LINE webhook was not found.', 404);
    const connection = await database.prepare("SELECT * FROM connections WHERE kind = 'line' AND status = 'active' LIMIT 1")
      .first<ConnectionRow>();
    if (!connection) return failure(context, 'LINE webhook was not found.', 404);
    const keyRecord = await context.env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
      .bind(organizationId).first<{ master_key_version: string; wrapped_key_envelope: string }>();
    if (!keyRecord) throw new Error('Organization encryption key is missing.');
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) },
      await masterKey(context.env.CREDENTIAL_MASTER_KEY),
      organizationId,
    );
    const credential = await connectionCredential(connection, organizationKey, organizationId, 'line');
    const rawBody = await context.req.text();
    const signature = context.req.header('x-line-signature') ?? '';
    if (!credential.channelSecret || !await verifyLineWebhookSignature(credential.channelSecret, rawBody, signature)) return failure(context, 'Invalid LINE webhook signature.', 401);
    const destinations = discoveredLineDestinations(JSON.parse(rawBody) as { events?: Array<{ source?: { type?: string; userId?: string; groupId?: string; roomId?: string } }> });
    const timestamp = now();
    await Promise.all(destinations.map((destination) => database.prepare(
      "INSERT OR IGNORE INTO line_destinations (id, connection_id, destination_id, kind, status, discovered_at, updated_at) VALUES (?, ?, ?, ?, 'discovered', ?, ?)",
    ).bind(crypto.randomUUID(), connection.id, destination.destinationId, destination.kind, timestamp, timestamp).run()));
    return json(context, { discovered: destinations.length });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE webhook could not be processed.', 400);
  }
});

app.post('/api/public/organizations/:organizationId/line-links/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const organization = await context.env.CONTROL_DB.prepare(
      "SELECT id, status, binding_name FROM organizations WHERE id = ? AND status = 'active'",
    ).bind(organizationId).first<{ id: string; status: string; binding_name: string }>();
    const database = organization ? organizationDatabase(context.env, organization.binding_name) : null;
    if (!database) return failure(context, 'Recipient Link was not found.', 404);
    const input = await context.req.json<{ destinationId?: string }>();
    if (!input.destinationId?.trim()) return failure(context, 'A discovered LINE Destination is required.');
    const link = await database.prepare(
      'SELECT recipient_profile_id, expires_at, used_at FROM recipient_link_tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(context.req.param('token'), now()).first<{ recipient_profile_id: string; expires_at: string; used_at: string | null }>();
    if (!link) return failure(context, 'Recipient Link has expired or was already used.', 410);
    const destination = await database.prepare("SELECT id FROM line_destinations WHERE destination_id = ? AND status = 'discovered' LIMIT 1")
      .bind(input.destinationId.trim()).first<{ id: string }>();
    if (!destination) return failure(context, 'LINE Destination was not found.', 404);
    const timestamp = now();
    await database.prepare(
      'INSERT OR IGNORE INTO recipient_line_destinations (recipient_profile_id, line_destination_id, created_at) VALUES (?, ?, ?)',
    ).bind(link.recipient_profile_id, destination.id, timestamp).run();
    const consumed = await database.prepare('UPDATE recipient_link_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL')
      .bind(timestamp, context.req.param('token')).run();
    if (consumed.meta.changes === 0) return failure(context, 'Recipient Link was already used.', 410);
    return json(context, { recipientProfileId: link.recipient_profile_id, destinationId: input.destinationId.trim() });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Link could not be consumed.', 409);
  }
});

app.patch('/api/organizations/:organizationId/suspension', async (context) => {
  try {
    const session = await sessionFromRequest(context.req.raw, context.env);
    if (!session) return failure(context, 'Authentication is required.', 401);
    const organizationId = context.req.param('organizationId');
    const membership = await context.env.CONTROL_DB.prepare(
      `SELECT o.id, o.status, m.role FROM members m JOIN organizations o ON o.id = m.organization_id
       WHERE m.identity_id = ? AND m.organization_id = ? AND m.state = 'active'`,
    ).bind(session.identity_id, organizationId).first<{ id: string; status: string; role: string }>();
    if (!membership || membership.role !== 'owner') return failure(context, 'Only an Owner can suspend or resume an Organization.', 403);
    const input = await context.req.json<{ suspended?: boolean }>();
    if (typeof input.suspended !== 'boolean') return failure(context, 'A suspension state is required.');
    const status = input.suspended ? 'suspended' : 'active';
    await context.env.CONTROL_DB.prepare('UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, now(), organizationId).run();
    return json(context, { organizationId, status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Organization suspension could not be changed.', 409);
  }
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
