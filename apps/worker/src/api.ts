import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, max, ne } from 'drizzle-orm';

import { canUpdateAttendance, discoveredLineDestinations, displayRecipientIdentifier, verifyLineWebhookSignature } from '@mail/domain';
import type { OrganizationSetup } from '@mail/domain';

import { createMailboxTestCalendarEvent, readMailboxTestSource, runOrganizationAutomation, searchMailboxForTest } from './automation';
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
import { organizationDatabase } from './organization-db';
import { createSetupOrganizationKey, provisionSetup } from './provisioning';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt } from './recovery-receipts';
import { exportRecipientCsv, previewRecipientCsv } from './recipients';
import { failure, json } from './response';
import type { Bindings, ConnectionRow, OrganizationRow, SessionRow } from './types';
import type { CipherEnvelope } from './cryptography';
import { extractGeminiEventDetails } from './event-details';
import type { EventDetails } from './event-details';
import { controlDatabase as drizzleControlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { createOrganizationStore } from './storage/organization-store';
import {
  googleLoginStates,
  identities,
  members,
  organizationKeys,
  organizations,
  organizationSetups,
  recoveryRequests,
  sessions,
} from './storage/control-schema';
import type { OrganizationSetupRecord } from './storage/control-schema';
import {
  attendance,
  connections as organizationConnections,
  deliveries as organizationDeliveries,
  eventOverrides,
  eventRecipients,
  events as organizationEvents,
  exceptions as organizationExceptions,
  googleConnections,
  jobs as organizationJobs,
  lineDestinations,
  listItems,
  lists as organizationLists,
  recipientLineDestinations,
  recipientLinkTokens,
  recipientProfiles,
  ruleRevisions,
  rules as organizationRules,
} from './storage/organization-schema';

const SETUP_COOKIE = 'mail_setup';
const SESSION_COOKIE = 'mail_session';
const SETUP_WINDOW_MS = 15 * 60 * 1_000;
const PROVISIONING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const GOOGLE_LOGIN_WINDOW_MS = 10 * 60 * 1_000;
const RECIPIENT_LINK_WINDOW_MS = 15 * 60 * 1_000;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const;

const isGeminiModel = (value: string): value is typeof GEMINI_MODELS[number] =>
  GEMINI_MODELS.includes(value as typeof GEMINI_MODELS[number]);

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
const setupView = (row: OrganizationSetupRecord): OrganizationSetup => ({
  id: row.id,
  name: row.name,
  inboxAddress: row.inboxAddress,
  status: row.state,
  expiresAt: row.expiresAt,
  provisioningExpiresAt: row.provisioningExpiresAt,
  phase: row.provisioningPhase,
  error: row.errorMessage,
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

const setupById = (env: Bindings, id: string): Promise<OrganizationSetupRecord | undefined> =>
  drizzleControlDatabase(env.CONTROL_DB).select().from(organizationSetups)
    .where(eq(organizationSetups.id, id)).get();

const setupFromRequest = async (request: Request, env: Bindings): Promise<OrganizationSetupRecord | null> => {
  const id = requestCookie(request.headers.get('Cookie') ?? undefined, SETUP_COOKIE);
  if (!id) return null;
  return await setupById(env, id) ?? null;
};

const validSetup = (row: OrganizationSetupRecord | null, state: OrganizationSetupRecord['state']): OrganizationSetupRecord => {
  if (!row || row.state !== state || Date.parse(row.expiresAt) <= Date.now()) throw new Error('Setup session expired.');
  return row;
};

const configurationError = (env: Bindings): string | null => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return 'Google OAuth credentials are not configured.';
  if (!env.CREDENTIAL_MASTER_KEY || !env.CREDENTIAL_MASTER_KEY_VERSION) return 'Credential encryption is not configured.';
  return null;
};

const organizationForRequest = async (
  request: Request,
  env: Bindings,
  organizationId: string,
): Promise<{ session: SessionRow; organization: OrganizationRow; role: string; database: D1Database | null }> => {
  const session = await sessionFromRequest(request, env);
  if (!session) throw new Error('Authentication is required.');
  const membership = await drizzleControlDatabase(env.CONTROL_DB).select({
    role: members.role,
    id: organizations.id,
    name: organizations.name,
    status: organizations.status,
    database_id: organizations.databaseId,
    binding_name: organizations.bindingName,
  }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.identityId, session.identity_id), eq(members.organizationId, organizationId), eq(members.state, 'active')))
    .get();
  if (!membership) throw new Error('この組織へのアクセス権がありません。');
  if (membership.status !== 'active') throw new Error('この組織は現在利用できません。');
  const database = organizationDatabase(env, membership.binding_name, membership.database_id);
  return { session, organization: membership, role: membership.role, database };
};

const organizationKeyForRequest = async (env: Bindings, organizationId: string): Promise<CryptoKey> => {
  const keyRecord = await drizzleControlDatabase(env.CONTROL_DB).select({
    masterKeyVersion: organizationKeys.masterKeyVersion,
    wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
  }).from(organizationKeys).where(eq(organizationKeys.organizationId, organizationId)).get();
  if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
  return unwrapOrganizationKey(
    { masterKeyVersion: keyRecord.masterKeyVersion, envelope: JSON.parse(keyRecord.wrappedKeyEnvelope) },
    await masterKey(env.CREDENTIAL_MASTER_KEY),
    organizationId,
  );
};

const activeOrganizationDatabase = async (env: Bindings, organizationId: string): Promise<D1Database | null> => {
  const organization = await drizzleControlDatabase(env.CONTROL_DB).select({
    databaseId: organizations.databaseId,
    bindingName: organizations.bindingName,
  }).from(organizations).where(and(
    eq(organizations.id, organizationId),
    eq(organizations.status, 'active'),
  )).get();
  return organization ? organizationDatabase(env, organization.bindingName, organization.databaseId) : null;
};

const mailTestContext = (organizationId: string): string => `mail-test-preview:${organizationId}`;
const MAIL_TEST_WINDOW_MS = 15 * 60 * 1_000;

interface MailTestConfirmation {
  messageId: string;
  event: EventDetails;
  expiresAt: string;
}

const isEventDetails = (value: unknown): value is EventDetails => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<EventDetails>;
  return typeof event.title === 'string'
    && typeof event.startsAt === 'string'
    && typeof event.endsAt === 'string'
    && typeof event.timeZone === 'string'
    && typeof event.location === 'string'
    && typeof event.description === 'string'
    && Number.isFinite(Date.parse(event.startsAt))
    && Number.isFinite(Date.parse(event.endsAt))
    && Date.parse(event.startsAt) < Date.parse(event.endsAt);
};

const extractMailTestEvent = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
): Promise<EventDetails | null> => {
  const connection = await drizzleOrganizationDatabase(database).select().from(organizationConnections)
    .where(and(eq(organizationConnections.kind, 'ai'), eq(organizationConnections.status, 'active'))).limit(1).get();
  if (!connection) throw new Error('先に Gemini API キーを保存してください。');
  const credential = await connectionCredential(connection, await organizationKeyForRequest(env, organizationId), organizationId, 'ai');
  if (credential.provider !== 'Google Gemini API' || !credential.apiKey) throw new Error('先に Gemini API キーを保存してください。');
  const model = credential.model || DEFAULT_GEMINI_MODEL;
  if (!isGeminiModel(model)) throw new Error('Gemini モデルは gemini-3.5-flash-lite または gemini-3.6-flash を選択してください。');
  return extractGeminiEventDetails({ apiKey: credential.apiKey, model, source });
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
  await drizzleControlDatabase(context.env.CONTROL_DB).insert(googleLoginStates).values({
    id,
    stateHash: await sha256(state),
    pkceVerifierEnvelope: JSON.stringify(verifierEnvelope),
    returnOrigin,
    expiresAt: expiresIn(GOOGLE_LOGIN_WINDOW_MS),
    createdAt: now(),
  }).run();
  return json(context, {
    authorizationUrl: googleAuthorizationUrl({
      clientId: context.env.GOOGLE_CLIENT_ID,
      redirectUri: googleLoginRedirectUri(context.env),
      state,
      challenge: pkce.challenge,
      scopes: GOOGLE_IDENTITY_SCOPES,
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
  const control = drizzleControlDatabase(context.env.CONTROL_DB);
  const login = await control.select({
    id: googleLoginStates.id,
    pkceVerifierEnvelope: googleLoginStates.pkceVerifierEnvelope,
    returnOrigin: googleLoginStates.returnOrigin,
  }).from(googleLoginStates).where(and(eq(googleLoginStates.stateHash, await sha256(state)), gt(googleLoginStates.expiresAt, now()))).get();
  if (!login) {
    target.searchParams.set('error', 'Google ログインの有効期限が切れました。もう一度お試しください。');
    return context.redirect(target.toString());
  }
  target = new URL('/', login.returnOrigin || context.env.WEB_ORIGIN || context.env.APP_URL);
  try {
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(login.pkceVerifierEnvelope), key, `google-login-pkce:${login.id}`);
    const tokenSet = await exchangeGoogleCode({
      code,
      verifier,
      clientId: context.env.GOOGLE_CLIENT_ID,
      clientSecret: context.env.GOOGLE_CLIENT_SECRET,
      redirectUri: googleLoginRedirectUri(context.env),
    });
    const identity = await fetchGoogleIdentity(tokenSet.accessToken);
    await revokeGoogleToken(tokenSet.refreshToken);
    const timestamp = now();
    await control.insert(identities).values({
      id: crypto.randomUUID(),
      email: identity.email,
      displayName: identity.displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: identities.email,
      set: { displayName: identity.displayName, updatedAt: timestamp },
    }).run();
    const owner = await control.select({ id: identities.id }).from(identities).where(eq(identities.email, identity.email)).get();
    if (!owner) throw new Error('Google identity could not be stored.');
    const sessionId = randomToken();
    await control.batch([
      control.delete(googleLoginStates).where(eq(googleLoginStates.id, login.id)),
      control.insert(sessions).values({ id: sessionId, identityId: owner.id, expiresAt: expiresIn(SESSION_WINDOW_MS), createdAt: timestamp, lastSeenAt: timestamp }),
    ]);
    context.header('Set-Cookie', cookie(SESSION_COOKIE, sessionId, requestIsSecure(context.req.raw), Math.floor(SESSION_WINDOW_MS / 1_000)));
  } catch (error) {
    target.searchParams.set('error', error instanceof Error ? error.message : 'Google ログインに失敗しました。');
  }
  return context.redirect(target.toString());
});

app.get('/api/organizations/:organizationId/automation', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const automation = await createOrganizationStore(drizzleOrganizationDatabase(access.database)).currentAutomation();
    return json(context, automation ? { ...automation, displayName: access.session.display_name } : null);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Inbox could not be loaded.', 403);
  }
});

app.post('/api/organizations/:organizationId/automation/run', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    return json(context, await runOrganizationAutomation(context.env, access.organization.id, access.database));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を実行できませんでした。', 409);
  }
});

app.post('/api/organizations/:organizationId/automation/enabled', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Automation can only be changed by an Owner, Admin, or Operator.', 403);
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const updated = await createOrganizationStore(drizzleOrganizationDatabase(access.database)).setAutomationEnabled(input.enabled, now());
    if (!updated) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を更新できませんでした。', 409);
  }
});

app.post('/api/setup', async (context) => {
  const input = await context.req.json<{ name?: string }>();
  const name = input.name?.trim() ?? '';
  const invalid = configurationError(context.env);
  if (invalid) return failure(context, invalid, 503);
  const id = crypto.randomUUID();
  const state = randomToken();
  const pkce = await createPkce();
  const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
  const verifierEnvelope = await encrypt(pkce.verifier, key, `setup-pkce:${id}`);
  const createdAt = now();
  const expiresAt = expiresIn(SETUP_WINDOW_MS);
  await drizzleControlDatabase(context.env.CONTROL_DB).insert(organizationSetups).values({
    id,
    name,
    state: 'awaiting_google',
    oauthStateHash: await sha256(state),
    pkceVerifierEnvelope: JSON.stringify(verifierEnvelope),
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  }).run();
  context.header('Set-Cookie', cookie(SETUP_COOKIE, id, requestIsSecure(context.req.raw), Math.floor(SETUP_WINDOW_MS / 1_000)));
  return json(context, { authorizationUrl: googleAuthorizationUrl({ clientId: context.env.GOOGLE_CLIENT_ID, redirectUri: redirectUri(context.env), state, challenge: pkce.challenge }) }, 201);
});

app.post('/api/setup/cancel', async (context) => {
  const setup = await setupFromRequest(context.req.raw, context.env);
  if (setup && ['awaiting_google', 'awaiting_name', 'provisioning', 'failed'].includes(setup.state)) await expireSetup(context.env, setup);
  context.header('Set-Cookie', cookie(SETUP_COOKIE, '', requestIsSecure(context.req.raw), 0));
  return json(context, { cancelled: true });
});

app.get('/oauth/google/callback', async (context) => {
  const code = context.req.query('code');
  const state = context.req.query('state');
  const target = new URL('/setup', context.env.WEB_ORIGIN || context.env.APP_URL);
  if (!code || !state) {
    target.searchParams.set('error', 'Google authorization was cancelled.');
    return context.redirect(target.toString());
  }
  const control = drizzleControlDatabase(context.env.CONTROL_DB);
  const row = await control.select().from(organizationSetups)
    .where(eq(organizationSetups.oauthStateHash, await sha256(state))).get();
  try {
    const setup = validSetup(row ?? null, 'awaiting_google');
    const key = await masterKey(context.env.CREDENTIAL_MASTER_KEY);
    const verifier = await decrypt(JSON.parse(setup.pkceVerifierEnvelope), key, `setup-pkce:${setup.id}`);
    const tokenSet = await exchangeGoogleCode({ code, verifier, clientId: context.env.GOOGLE_CLIENT_ID, clientSecret: context.env.GOOGLE_CLIENT_SECRET, redirectUri: redirectUri(context.env) });
    if (!hasCompleteGoogleGrant(tokenSet.scopes)) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await expireSetup(context.env, setup);
      target.searchParams.set('error', `Required Google permissions are missing: ${missingGoogleScopes(tokenSet.scopes).join(', ')}`);
      return context.redirect(target.toString());
    }
    const [identity, historyId] = await Promise.all([fetchGoogleIdentity(tokenSet.accessToken), fetchGmailHistoryId(tokenSet.accessToken)]);
    const identityCreatedAt = now();
    await control.insert(identities).values({
      id: crypto.randomUUID(),
      email: identity.email,
      displayName: identity.displayName,
      createdAt: identityCreatedAt,
      updatedAt: identityCreatedAt,
    }).onConflictDoUpdate({
      target: identities.email,
      set: { displayName: identity.displayName, updatedAt: identityCreatedAt },
    }).run();
    const owner = await control.select({ id: identities.id }).from(identities).where(eq(identities.email, identity.email)).get();
    if (!owner) throw new Error('Google identity could not be stored.');
    const existingOrganization = await control.select({
      id: organizations.id,
      databaseId: organizations.databaseId,
    }).from(organizations).innerJoin(members, eq(members.organizationId, organizations.id))
      .where(eq(members.identityId, owner.id)).limit(1).get();
    if (existingOrganization?.databaseId === null) {
      await control.batch([
        control.update(organizationSetups).set({ organizationId: null, databaseId: null, bindingName: null }).where(eq(organizationSetups.organizationId, existingOrganization.id)),
        control.delete(organizationKeys).where(eq(organizationKeys.organizationId, existingOrganization.id)),
        control.delete(organizations).where(eq(organizations.id, existingOrganization.id)),
      ]);
    }
    const pendingSetup = await control.select({ id: organizationSetups.id }).from(organizationSetups).where(and(
      eq(organizationSetups.inboxAddress, identity.email),
      ne(organizationSetups.id, setup.id),
      inArray(organizationSetups.state, ['awaiting_google', 'awaiting_name', 'provisioning', 'failed']),
    )).limit(1).get();
    if ((existingOrganization && existingOrganization.databaseId !== null) || pendingSetup) {
      await revokeGoogleToken(tokenSet.refreshToken);
      await expireSetup(context.env, setup);
      target.searchParams.set('error', 'This Automation Inbox is already assigned to an Organization.');
      return context.redirect(target.toString());
    }
    const credentialEnvelope = await encrypt(JSON.stringify(tokenSet), key, `setup-credential:${setup.id}`);
    await control.update(organizationSetups).set({
      name: setup.name || identity.displayName || identity.email,
      state: 'awaiting_name',
      inboxAddress: identity.email,
      googleSubject: identity.subject,
      grantedScopes: JSON.stringify(tokenSet.scopes),
      credentialEnvelope: JSON.stringify(credentialEnvelope),
      historyId,
      ownerIdentityId: owner.id,
      expiresAt: expiresIn(SETUP_WINDOW_MS),
      updatedAt: now(),
    }).where(eq(organizationSetups.id, setup.id)).run();
    const ready = await setupById(context.env, setup.id);
    if (!ready) throw new Error('Organization setup could not be resumed.');
    const sessionId = randomToken();
    const sessionCreatedAt = now();
    await control.insert(sessions).values({
      id: sessionId,
      identityId: owner.id,
      expiresAt: expiresIn(SESSION_WINDOW_MS),
      createdAt: sessionCreatedAt,
      lastSeenAt: sessionCreatedAt,
    }).run();
    context.header('Set-Cookie', cookie(SESSION_COOKIE, sessionId, requestIsSecure(context.req.raw), Math.floor(SESSION_WINDOW_MS / 1_000)), { append: true });
    context.header('Set-Cookie', cookie(SETUP_COOKIE, setup.id, requestIsSecure(context.req.raw), Math.floor(SETUP_WINDOW_MS / 1_000)), { append: true });
  } catch (error) {
    target.searchParams.set('error', error instanceof Error ? error.message : 'Google authorization failed.');
  }
  return context.redirect(target.toString());
});

app.get('/api/setup/current', async (context) => {
  const row = await setupFromRequest(context.req.raw, context.env);
  if (!row) return json(context, null);
  if ((row.state === 'awaiting_google' || row.state === 'awaiting_name') && Date.parse(row.expiresAt) <= Date.now()) {
    await expireSetup(context.env, row);
    return json(context, { ...setupView(row), status: 'expired' });
  }
  return json(context, setupView(row));
});

app.post('/api/setup/complete', async (context) => {
  const setup = await setupFromRequest(context.req.raw, context.env);
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!setup || setup.state !== 'awaiting_name') return failure(context, 'Organization setup is not waiting for name confirmation.', 409);
  if (!session || session.identity_id !== setup.ownerIdentityId) return failure(context, 'Authentication is required.', 401);
  const input = await context.req.json<{ name?: string }>();
  const name = input.name?.trim() || setup.name;
  if (!name) return failure(context, 'Organization name is required.');
  await drizzleControlDatabase(context.env.CONTROL_DB).update(organizationSetups).set({ name, updatedAt: now() })
    .where(eq(organizationSetups.id, setup.id)).run();
  const ready = await setupById(context.env, setup.id);
  if (!ready) return failure(context, 'Organization setup could not be resumed.', 409);
  await beginOrganizationProvisioning(context.env, ready);
  const current = await setupById(context.env, setup.id);
  return json(context, current ? setupView(current) : null);
});

app.post('/api/setup/retry', async (context) => {
  const setup = await setupFromRequest(context.req.raw, context.env);
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!setup || setup.state !== 'failed' || !setup.ownerIdentityId) return failure(context, 'Organization setup is not waiting for retry.', 409);
  if (!session || session.identity_id !== setup.ownerIdentityId) return failure(context, 'Authentication is required.', 401);
  if (!setup.provisioningExpiresAt || Date.parse(setup.provisioningExpiresAt) <= Date.now()) {
    await expireSetup(context.env, setup);
    return failure(context, 'Organization setup expired. Start over with Google authorization.', 410);
  }
  await drizzleControlDatabase(context.env.CONTROL_DB).update(organizationSetups)
    .set({ state: 'provisioning', errorMessage: null, updatedAt: now() })
    .where(eq(organizationSetups.id, setup.id)).run();
  const ready = await setupById(context.env, setup.id);
  if (!ready) return failure(context, 'Organization setup could not be retried.', 409);
  await attemptProvision(context.env, ready);
  const current = await setupById(context.env, setup.id);
  return json(context, current ? setupView(current) : null);
});

app.get('/api/auth/me', async (context) => {
  const session = await sessionFromRequest(context.req.raw, context.env);
  if (!session) return failure(context, 'Authentication is required.', 401);
  const memberships = await drizzleControlDatabase(context.env.CONTROL_DB).select({
    organizationId: members.organizationId,
    role: members.role,
    name: organizations.name,
    status: organizations.status,
  }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.identityId, session.identity_id), eq(members.state, 'active'), isNotNull(organizations.databaseId))).all();
  return json(context, { email: session.email, displayName: session.display_name, organizations: memberships });
});

app.post('/api/auth/logout', async (context) => {
  const sessionId = requestCookie(context.req.header('Cookie'), SESSION_COOKIE);
  if (sessionId) await drizzleControlDatabase(context.env.CONTROL_DB).update(sessions).set({ revokedAt: now() }).where(eq(sessions.id, sessionId)).run();
  context.header('Set-Cookie', cookie(SESSION_COOKIE, '', requestIsSecure(context.req.raw), 0));
  return json(context, { loggedOut: true });
});

app.get('/api/organizations/:organizationId/connections', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationConnections)
      .where(and(inArray(organizationConnections.kind, ['line', 'ai']), eq(organizationConnections.status, 'active'))).all();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const line = rows.find((row) => row.kind === 'line');
    const ai = rows.find((row) => row.kind === 'ai');
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
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const database = access.database;
    const db = drizzleOrganizationDatabase(database);
    const input = await context.req.json<OrganizationConnectionInput>();
    const rows = await db.select().from(organizationConnections)
      .where(and(inArray(organizationConnections.kind, ['line', 'ai']), eq(organizationConnections.status, 'active'))).all();
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const existingLine = rows.find((row) => row.kind === 'line');
    const existingAi = rows.find((row) => row.kind === 'ai');
    const [lineCredential, aiCredential] = await Promise.all([
      connectionCredential(existingLine ?? null, organizationKey, organizationId, 'line'),
      connectionCredential(existingAi ?? null, organizationKey, organizationId, 'ai'),
    ]);
    const nextLine: OrganizationCredential = { ...lineCredential, ...input.line };
    const nextAi: OrganizationCredential = { ...aiCredential, ...input.ai };
    const updatingLine = Boolean(input.line?.channelAccessToken || input.line?.channelSecret);
    if (updatingLine && (!nextLine.channelAccessToken || !nextLine.channelSecret)) return failure(context, 'LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    if (nextAi.provider !== 'Google Gemini API' || !nextAi.apiKey || !nextAi.model) return failure(context, 'Gemini API キーを入力してください。');
    if (!isGeminiModel(nextAi.model)) return failure(context, 'Gemini モデルは gemini-3.5-flash-lite または gemini-3.6-flash を選択してください。');
    const timestamp = now();
    const lineEnvelope = await encrypt(JSON.stringify(nextLine), organizationKey, connectionContext(organizationId, 'line'));
    const aiEnvelope = await encrypt(JSON.stringify(nextAi), organizationKey, connectionContext(organizationId, 'ai'));
    const save = async (existing: typeof organizationConnections.$inferSelect | undefined, kind: 'line' | 'ai', label: string, credential: string): Promise<void> => {
      if (existing) {
        await db.update(organizationConnections).set({ label, credential, status: 'active', updatedAt: timestamp })
          .where(eq(organizationConnections.id, existing.id)).run();
        return;
      }
      await db.insert(organizationConnections).values({ id: crypto.randomUUID(), kind, label, credential, status: 'active', createdAt: timestamp, updatedAt: timestamp }).run();
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
});

app.get('/oauth/gemini/callback', async (context) => {
  const discontinuedTarget = new URL('/', context.env.WEB_ORIGIN || context.env.APP_URL);
  discontinuedTarget.searchParams.set('error', 'Google Cloud OAuth 接続は廃止されました。Google AI Studio の Gemini API キーを設定してください。');
  return context.redirect(discontinuedTarget.toString());
});

app.post('/api/organizations/:organizationId/connections/gemini/test', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const input = await context.req.json<{ prompt?: string; model?: string }>();
    const prompt = input.prompt?.trim() ?? '';
    if (!prompt || prompt.length > 10_000) return failure(context, 'テスト用の質問は 1〜10,000 文字で入力してください。');
    const existing = await drizzleOrganizationDatabase(access.database).select().from(organizationConnections)
      .where(and(eq(organizationConnections.kind, 'ai'), eq(organizationConnections.status, 'active'))).limit(1).get();
    if (!existing) return failure(context, 'Gemini API キーを設定してください。', 409);
    const organizationKey = await organizationKeyForRequest(context.env, organizationId);
    const credential = await connectionCredential(existing, organizationKey, organizationId, 'ai');
    if (credential.provider !== 'Google Gemini API' || !credential.apiKey) return failure(context, 'Gemini API キーを設定してください。', 409);
    const model = input.model?.trim() || credential.model || DEFAULT_GEMINI_MODEL;
    if (!isGeminiModel(model)) return failure(context, 'Gemini モデルは gemini-3.5-flash-lite または gemini-3.6-flash を選択してください。');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': credential.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });
    const body = await response.json() as GeminiGenerateContentResponse;
    if (!response.ok) throw new Error(body.error?.message ?? 'Gemini API が応答しませんでした。');
    const text = generatedText(body);
    if (!text) throw new Error('Gemini API からテキスト応答を受け取れませんでした。');
    return json(context, { text, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini API の接続テストに失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/search', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'メールの手動テストを実行できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ subject?: string }>();
    const subject = input.subject?.trim() ?? '';
    if (!subject || subject.length > 300) return failure(context, '件名は 1〜300 文字で入力してください。');
    const automation = await createOrganizationStore(drizzleOrganizationDatabase(access.database)).currentAutomation();
    if (!automation) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { accountEmail: automation.email, messages: await searchMailboxForTest(context.env, organizationId, access.database, subject) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gmail の検索に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/:messageId/preview', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'メールの手動テストを実行できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。接続設定は保存されていません。', 503);
    const messageId = context.req.param('messageId');
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId)) return failure(context, 'Gmail メッセージ ID が不正です。');
    const source = await readMailboxTestSource(context.env, organizationId, access.database, messageId);
    const event = await extractMailTestEvent(context.env, organizationId, access.database, source.source);
    if (!event) return failure(context, 'メールから安全な予定を抽出できませんでした。日付・開始時刻・終了時刻を確認してください。');
    const confirmation: MailTestConfirmation = { messageId, event, expiresAt: expiresIn(MAIL_TEST_WINDOW_MS) };
    const token = JSON.stringify(await encrypt(JSON.stringify(confirmation), await organizationKeyForRequest(context.env, organizationId), mailTestContext(organizationId)));
    return json(context, { id: source.id, subject: source.subject, sender: source.sender, event, confirmationToken: token, expiresAt: confirmation.expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI による予定の抽出に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.post('/api/organizations/:organizationId/mail-tests/calendar', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const access = await organizationForRequest(context.req.raw, context.env, organizationId);
    if (access.role !== 'owner' && access.role !== 'admin') return failure(context, 'テスト予定を作成できる権限がありません。', 403);
    if (!access.database) return failure(context, '組織DBに接続できません。', 503);
    const input = await context.req.json<{ confirmationToken?: string }>();
    if (!input.confirmationToken || input.confirmationToken.length > 10_000) return failure(context, '確認用トークンがありません。先に AI 抽出を実行してください。');
    const confirmation = JSON.parse(await decrypt(JSON.parse(input.confirmationToken) as CipherEnvelope, await organizationKeyForRequest(context.env, organizationId), mailTestContext(organizationId))) as Partial<MailTestConfirmation>;
    if (typeof confirmation.messageId !== 'string' || !isEventDetails(confirmation.event) || typeof confirmation.expiresAt !== 'string' || Date.parse(confirmation.expiresAt) <= Date.now()) {
      return failure(context, 'プレビューの有効期限が切れました。もう一度 AI 抽出を実行してください。', 409);
    }
    return json(context, await createMailboxTestCalendarEvent(context.env, organizationId, access.database, { messageId: confirmation.messageId, event: confirmation.event }), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google Calendar へのテスト予定作成に失敗しました。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 500);
  }
});

app.get('/api/organizations/:organizationId/lists', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const database = drizzleOrganizationDatabase(access.database);
    const rows = await database.select().from(organizationLists).orderBy(asc(organizationLists.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    const kind = input.kind?.trim() as 'source' | 'recipient' | 'line' | undefined;
    const name = input.name?.trim();
    if (!kind || !['source', 'recipient', 'line'].includes(kind)) return failure(context, 'Unsupported Typed List kind.');
    if (!name) return failure(context, 'Typed List name is required.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const description = input.description?.trim() ?? '';
    await drizzleOrganizationDatabase(access.database).insert(organizationLists).values({
      id,
      organizationId: access.organization.id,
      kind,
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
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
    await drizzleOrganizationDatabase(access.database).insert(listItems).values({
      id,
      listId: context.req.param('listId'),
      value,
      label: input.label?.trim() ?? '',
      enabled: true,
    }).run();
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
    const updated = await drizzleOrganizationDatabase(access.database).update(listItems)
      .set({ enabled: input.enabled })
      .where(and(eq(listItems.id, context.req.param('itemId')), eq(listItems.listId, context.req.param('listId'))))
      .returning({ id: listItems.id }).get();
    if (!updated) return failure(context, 'List Item was not found.', 404);
    return json(context, { id: context.req.param('itemId'), enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/rules', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationRules)
      .orderBy(desc(organizationRules.priority), asc(organizationRules.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      state: row.status,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routingPolicy) as Record<string, unknown>,
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    const state = (input.state ?? 'draft') as 'draft' | 'active' | 'suspended' | 'archived';
    if (!name) return failure(context, 'Rule name is required.');
    if (!['draft', 'active', 'suspended', 'archived'].includes(state)) return failure(context, 'Unsupported Rule State.');
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(input.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(input.routingPolicy ?? {});
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.insert(organizationRules).values({
        id,
        organizationId: access.organization.id,
        name,
        status: state,
        selectionPolicy,
        routingPolicy,
        priority,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      database.insert(ruleRevisions).values({
        id: crypto.randomUUID(),
        ruleId: id,
        revision: 1,
        selectionPolicy,
        routingPolicy,
        createdAt: timestamp,
      }),
    ]);
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
    const state = input.state as 'draft' | 'active' | 'suspended' | 'archived';
    const updated = await drizzleOrganizationDatabase(access.database).update(organizationRules)
      .set({ status: state, updatedAt: now() })
      .where(eq(organizationRules.id, context.req.param('ruleId')))
      .returning({ id: organizationRules.id }).get();
    if (!updated) return failure(context, 'Rule was not found.', 404);
    return json(context, { id: context.req.param('ruleId'), state: input.state });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Rule could not be updated.', 409);
  }
});

app.get('/api/organizations/:organizationId/recipients', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(recipientProfiles)
      .orderBy(asc(recipientProfiles.name)).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      organizationId: access.organization.id,
      name: row.name,
      email: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.email),
      state: row.state,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Profiles could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/recipients/export', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select({
      name: recipientProfiles.name,
      email: recipientProfiles.email,
    }).from(recipientProfiles).where(eq(recipientProfiles.state, 'active')).orderBy(asc(recipientProfiles.name)).all();
    return new Response(exportRecipientCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="recipients.csv"' } });
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
    await drizzleOrganizationDatabase(access.database).insert(recipientProfiles).values({
      id,
      organizationId: access.organization.id,
      name,
      email,
      state: 'active',
      tags: '[]',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
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
    const updates: Partial<typeof recipientProfiles.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return failure(context, 'Recipient name cannot be empty.');
      updates.name = name;
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (!email.includes('@')) return failure(context, 'A valid Recipient email address is required.');
      updates.email = email;
    }
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) return failure(context, 'Recipient tags must be non-empty strings.');
      tags = input.tags.map((tag) => tag.trim());
      updates.tags = JSON.stringify(tags);
    }
    if (input.state !== undefined) {
      if (!['active', 'inactive'].includes(input.state)) return failure(context, 'Unsupported Recipient state.');
      updates.state = input.state as 'active' | 'inactive';
    }
    if (Object.keys(updates).length === 0) return failure(context, 'At least one Recipient field is required.');
    const updated = await drizzleOrganizationDatabase(access.database).update(recipientProfiles)
      .set({ ...updates, updatedAt: now() })
      .where(eq(recipientProfiles.id, context.req.param('recipientId')))
      .returning({ id: recipientProfiles.id }).get();
    if (!updated) return failure(context, 'Recipient Profile was not found.', 404);
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
    const database = drizzleOrganizationDatabase(access.database);
    await database.batch([
      database.update(recipientLinkTokens).set({ usedAt: timestamp }).where(and(
        eq(recipientLinkTokens.recipientProfileId, context.req.param('recipientId')),
        isNull(recipientLinkTokens.usedAt),
      )),
      database.insert(recipientLinkTokens).values({
        token,
        recipientProfileId: context.req.param('recipientId'),
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      }),
    ]);
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
    const database = drizzleOrganizationDatabase(access.database);
    const writes = await Promise.all(preview.accepted.map((recipient) => database.insert(recipientProfiles).values({
      id: crypto.randomUUID(),
      organizationId: access.organization.id,
      name: recipient.name,
      email: recipient.email,
      state: 'active',
      tags: '[]',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning({ id: recipientProfiles.id }).get()));
    const imported = writes.filter(Boolean).length;
    return json(context, { imported, duplicates: preview.duplicates, invalid: preview.invalid }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient import could not be completed.', 409);
  }
});

app.get('/api/organizations/:organizationId/dashboard', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const database = drizzleOrganizationDatabase(access.database);
    const [rules, events, jobs, exceptions, connection] = await Promise.all([
      database.select({ value: count() }).from(organizationRules).where(eq(organizationRules.status, 'active')).get(),
      database.select({ value: count() }).from(organizationEvents).where(and(eq(organizationEvents.status, 'scheduled'), gte(organizationEvents.startsAt, now()))).get(),
      database.select({ value: count() }).from(organizationJobs).where(inArray(organizationJobs.state, ['pending', 'running'])).get(),
      database.select({ value: count() }).from(organizationExceptions).where(eq(organizationExceptions.state, 'open')).get(),
      database.select({ value: max(googleConnections.updatedAt) }).from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get(),
    ]);
    return json(context, {
      activeRules: rules?.value ?? 0,
      upcomingEvents: events?.value ?? 0,
      pendingJobs: jobs?.value ?? 0,
      exceptions: exceptions?.value ?? 0,
      lastSyncedAt: connection?.value ?? null,
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
    const updates: Partial<typeof members.$inferInsert> = { updatedAt: now() };
    if (input.role !== undefined) updates.role = input.role as 'owner' | 'admin' | 'operator' | 'viewer';
    if (input.state !== undefined) updates.state = input.state as 'active' | 'suspended';
    const updated = await drizzleControlDatabase(context.env.CONTROL_DB).update(members).set(updates).where(and(
      eq(members.organizationId, access.organization.id),
      eq(members.identityId, context.req.param('identityId')),
    )).returning({ identityId: members.identityId }).get();
    if (!updated) return failure(context, 'Member was not found.', 404);
    return json(context, { identityId: context.req.param('identityId'), ...(input.role === undefined ? {} : { role: input.role }), ...(input.state === undefined ? {} : { state: input.state }) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Member could not be updated.', 409);
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
    await drizzleControlDatabase(context.env.CONTROL_DB).insert(recoveryRequests).values({
      id,
      organizationId: access.organization.id,
      idempotencyKey,
      state: 'requested',
      requestedByIdentityId: access.session.identity_id,
      createdAt: timestamp,
    }).run();
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
    const control = drizzleControlDatabase(context.env.CONTROL_DB);
    const request = await control.select({
      id: recoveryRequests.id,
      idempotencyKey: recoveryRequests.idempotencyKey,
    }).from(recoveryRequests).where(and(
      eq(recoveryRequests.id, context.req.param('requestId')),
      eq(recoveryRequests.organizationId, access.organization.id),
      eq(recoveryRequests.state, 'requested'),
    )).get();
    if (!request) return failure(context, 'Recovery request was not found or is no longer pending.', 404);
    const claimed = await control.update(recoveryRequests).set({
      state: 'executing',
      executedByIdentityId: access.session.identity_id,
    }).where(and(eq(recoveryRequests.id, request.id), eq(recoveryRequests.state, 'requested')))
      .returning({ id: recoveryRequests.id }).get();
    if (!claimed) return failure(context, 'Recovery request is already being executed.', 409);
    try {
      const keyRecord = await control.select({
        masterKeyVersion: organizationKeys.masterKeyVersion,
        wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
      }).from(organizationKeys).where(eq(organizationKeys.organizationId, access.organization.id)).get();
      if (!keyRecord) throw new Error('Organization encryption key is missing.');
      const organizationKey = await unwrapOrganizationKey(
        { masterKeyVersion: keyRecord.masterKeyVersion, envelope: JSON.parse(keyRecord.wrappedKeyEnvelope) },
        await masterKey(context.env.CREDENTIAL_MASTER_KEY), access.organization.id,
      );
      const receipt = await readRecoveryReceipt({ bucket: context.env.RECOVERY_RECEIPTS, organizationKey, organizationId: access.organization.id, idempotencyKey: request.idempotencyKey });
      if (!receipt) throw new Error('The requested recovery receipt no longer exists.');
      await restoreDeliveryRecordFromReceipt(access.database, receipt);
      await control.update(recoveryRequests).set({ state: 'completed', executedAt: now(), errorMessage: null })
        .where(eq(recoveryRequests.id, request.id)).run();
      return json(context, { id: request.id, state: 'completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery execution failed.';
      await control.update(recoveryRequests).set({ state: 'failed', errorMessage: message, executedAt: now() })
        .where(eq(recoveryRequests.id, request.id)).run();
      return failure(context, message, 409);
    }
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recovery execution could not be started.', 409);
  }
});

app.post('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'Attendance link was not found.', 404);
    const input = await context.req.json<{ eventId?: string; status?: string; comment?: string }>();
    if (!input.eventId || !['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) return failure(context, 'A response status is required.');
    const comment = input.comment?.trim() ?? '';
    if (comment.length > 1_000) return failure(context, 'Attendance comment is too long.');
    const organizationDb = drizzleOrganizationDatabase(database);
    const link = await organizationDb.select({
      linkEventId: attendance.eventId,
      revokedAt: attendance.revokedAt,
      attendanceDeadline: organizationEvents.attendanceDeadline,
    }).from(attendance).innerJoin(organizationEvents, eq(organizationEvents.id, attendance.eventId))
      .where(eq(attendance.token, context.req.param('token'))).get();
    if (!link || !link.attendanceDeadline || !canUpdateAttendance({
      eventId: input.eventId,
      linkEventId: link.linkEventId,
      revokedAt: link.revokedAt,
      deadline: link.attendanceDeadline,
      now: now(),
    })) return failure(context, 'Attendance link is no longer available.', 410);
    await organizationDb.update(attendance).set({
      status: input.status as 'unanswered' | 'attending' | 'not_attending',
      comment,
      updatedAt: now(),
    }).where(and(eq(attendance.token, context.req.param('token')), eq(attendance.eventId, input.eventId))).run();
    return json(context, { eventId: input.eventId, status: input.status });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance response could not be saved.', 409);
  }
});

app.get('/api/public/organizations/:organizationId/attendance/:token', async (context) => {
  const database = await activeOrganizationDatabase(context.env, context.req.param('organizationId'));
  if (!database) return failure(context, 'Attendance link was not found.', 404);
  const row = await drizzleOrganizationDatabase(database).select({
    eventId: attendance.eventId,
    status: attendance.status,
    comment: attendance.comment,
  }).from(attendance).where(and(
    eq(attendance.token, context.req.param('token')),
    isNull(attendance.revokedAt),
  )).get();
  if (!row) return failure(context, 'Attendance link was not found.', 404);
  return json(context, row);
});

app.patch('/api/organizations/:organizationId/events/:eventId', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Events can only be changed by an Owner, Admin, or Operator.', 403);
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ title?: string; startsAt?: string; endsAt?: string; location?: string; description?: string; status?: string; reason?: string }>();
    const changeSet = {
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt.trim() }),
      ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt.trim() }),
      ...(input.location === undefined ? {} : { location: input.location.trim() }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.status === undefined ? {} : { status: input.status.trim() }),
    };
    if (!Object.keys(changeSet).length || Object.values(changeSet).some((value) => value === '')) return failure(context, 'At least one non-empty Event field is required.');
    const status = changeSet.status;
    if (status && !['draft', 'scheduled', 'cancelled', 'exception'].includes(status)) return failure(context, 'Unsupported Event status.');
    const updates: Partial<typeof organizationEvents.$inferInsert> = {};
    if (changeSet.title !== undefined) updates.title = changeSet.title;
    if (changeSet.startsAt !== undefined) updates.startsAt = changeSet.startsAt;
    if (changeSet.endsAt !== undefined) updates.endsAt = changeSet.endsAt;
    if (changeSet.location !== undefined) updates.location = changeSet.location;
    if (changeSet.description !== undefined) updates.description = changeSet.description;
    if (status !== undefined) updates.status = status as 'draft' | 'scheduled' | 'cancelled' | 'exception';
    const timestamp = now();
    const database = drizzleOrganizationDatabase(access.database);
    const updated = await database.update(organizationEvents).set({ ...updates, updatedAt: timestamp })
      .where(eq(organizationEvents.id, context.req.param('eventId')))
      .returning({ id: organizationEvents.id }).get();
    if (!updated) return failure(context, 'Event was not found.', 404);
    await database.insert(eventOverrides).values({
      id: crypto.randomUUID(),
      eventId: context.req.param('eventId'),
      actorIdentityId: access.session.identity_id,
      changesJson: JSON.stringify(changeSet),
      reason: input.reason?.trim() ?? '',
      createdAt: timestamp,
    }).run();
    return json(context, { id: context.req.param('eventId'), updatedFields: Object.keys(changeSet) });
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
    await drizzleOrganizationDatabase(access.database).insert(attendance).values({
      eventId,
      recipientItemId: input.recipientItemId.trim(),
      status: 'unanswered',
      comment: '',
      token,
      revokedAt: null,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: [attendance.eventId, attendance.recipientItemId],
      set: { token, status: 'unanswered', comment: '', revokedAt: null, updatedAt: timestamp },
    }).run();
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
    const database = drizzleOrganizationDatabase(access.database);
    const recipients = await database.select({
      id: recipientProfiles.id,
      name: recipientProfiles.name,
      email: recipientProfiles.email,
    }).from(recipientProfiles).where(and(
      inArray(recipientProfiles.id, recipientProfileIds),
      eq(recipientProfiles.state, 'active'),
    )).all();
    if (recipients.length !== recipientProfileIds.length) return failure(context, 'One or more active Recipient Profiles were not found.', 404);
    const timestamp = now();
    await Promise.all(recipients.map((recipient) => database.insert(eventRecipients).values({
      eventId: context.req.param('eventId'),
      recipientProfileId: recipient.id,
      nameSnapshot: recipient.name,
      emailSnapshot: recipient.email,
      createdAt: timestamp,
    }).onConflictDoNothing().run()));
    return json(context, { eventId: context.req.param('eventId'), snapshotted: recipients.length }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient snapshots could not be created.', 409);
  }
});

app.get('/api/organizations/:organizationId/audit/deliveries', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationDeliveries)
      .orderBy(desc(organizationDeliveries.createdAt)).limit(100).all();
    return json(context, rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      channel: row.channel,
      destination: displayRecipientIdentifier(access.role as 'owner' | 'admin' | 'operator' | 'viewer', row.destination),
      outcome: row.outcome,
      externalId: row.externalId,
      createdAt: row.createdAt,
    })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Delivery audit could not be loaded.', 403);
  }
});

app.get('/api/organizations/:organizationId/operations/exceptions', async (context) => {
  try {
    const access = await organizationForRequest(context.req.raw, context.env, context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const rows = await drizzleOrganizationDatabase(access.database).select().from(organizationExceptions)
      .orderBy(desc(organizationExceptions.createdAt)).limit(100).all();
    return json(context, rows.map((row) => ({
      id: row.id, sourceMessageId: row.sourceMessageId, code: row.code, message: row.message, state: row.state, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
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
    const database = drizzleOrganizationDatabase(access.database);
    if (input.action === 'resolve') {
      const updated = await database.update(organizationExceptions).set({ state: 'resolved', resolvedAt: now() }).where(and(
        eq(organizationExceptions.id, context.req.param('exceptionId')),
        ne(organizationExceptions.state, 'resolved'),
      )).returning({ id: organizationExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found or already resolved.', 404);
      return json(context, { id: context.req.param('exceptionId'), state: 'resolved' });
    }
    if (input.action === 'retry') {
      const updated = await database.update(organizationExceptions).set({ state: 'retry_requested', resolvedAt: null })
        .where(eq(organizationExceptions.id, context.req.param('exceptionId')))
        .returning({ id: organizationExceptions.id }).get();
      if (!updated) return failure(context, 'Exception was not found.', 404);
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
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'LINE webhook was not found.', 404);
    const organizationDb = drizzleOrganizationDatabase(database);
    const connection = await organizationDb.select().from(organizationConnections).where(and(
      eq(organizationConnections.kind, 'line'),
      eq(organizationConnections.status, 'active'),
    )).limit(1).get();
    if (!connection) return failure(context, 'LINE webhook was not found.', 404);
    const keyRecord = await drizzleControlDatabase(context.env.CONTROL_DB).select({
      masterKeyVersion: organizationKeys.masterKeyVersion,
      wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
    }).from(organizationKeys).where(eq(organizationKeys.organizationId, organizationId)).get();
    if (!keyRecord) throw new Error('Organization encryption key is missing.');
    const organizationKey = await unwrapOrganizationKey(
      { masterKeyVersion: keyRecord.masterKeyVersion, envelope: JSON.parse(keyRecord.wrappedKeyEnvelope) },
      await masterKey(context.env.CREDENTIAL_MASTER_KEY),
      organizationId,
    );
    const credential = await connectionCredential(connection, organizationKey, organizationId, 'line');
    const rawBody = await context.req.text();
    const signature = context.req.header('x-line-signature') ?? '';
    if (!credential.channelSecret || !await verifyLineWebhookSignature(credential.channelSecret, rawBody, signature)) return failure(context, 'Invalid LINE webhook signature.', 401);
    const destinations = discoveredLineDestinations(JSON.parse(rawBody) as { events?: Array<{ source?: { type?: string; userId?: string; groupId?: string; roomId?: string } }> });
    const timestamp = now();
    await Promise.all(destinations.map((destination) => organizationDb.insert(lineDestinations).values({
      id: crypto.randomUUID(),
      connectionId: connection.id,
      destinationId: destination.destinationId,
      kind: destination.kind,
      status: 'discovered',
      discoveredAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().run()));
    return json(context, { discovered: destinations.length });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'LINE webhook could not be processed.', 400);
  }
});

app.post('/api/public/organizations/:organizationId/line-links/:token', async (context) => {
  try {
    const organizationId = context.req.param('organizationId');
    const database = await activeOrganizationDatabase(context.env, organizationId);
    if (!database) return failure(context, 'Recipient Link was not found.', 404);
    const organizationDb = drizzleOrganizationDatabase(database);
    const input = await context.req.json<{ destinationId?: string }>();
    if (!input.destinationId?.trim()) return failure(context, 'A discovered LINE Destination is required.');
    const link = await organizationDb.select({
      recipientProfileId: recipientLinkTokens.recipientProfileId,
    }).from(recipientLinkTokens).where(and(
      eq(recipientLinkTokens.token, context.req.param('token')),
      isNull(recipientLinkTokens.usedAt),
      gt(recipientLinkTokens.expiresAt, now()),
    )).get();
    if (!link) return failure(context, 'Recipient Link has expired or was already used.', 410);
    const destination = await organizationDb.select({ id: lineDestinations.id }).from(lineDestinations).where(and(
      eq(lineDestinations.destinationId, input.destinationId.trim()),
      eq(lineDestinations.status, 'discovered'),
    )).limit(1).get();
    if (!destination) return failure(context, 'LINE Destination was not found.', 404);
    const timestamp = now();
    await organizationDb.insert(recipientLineDestinations).values({
      recipientProfileId: link.recipientProfileId,
      lineDestinationId: destination.id,
      createdAt: timestamp,
    }).onConflictDoNothing().run();
    const consumed = await organizationDb.update(recipientLinkTokens).set({ usedAt: timestamp }).where(and(
      eq(recipientLinkTokens.token, context.req.param('token')),
      isNull(recipientLinkTokens.usedAt),
    )).returning({ token: recipientLinkTokens.token }).get();
    if (!consumed) return failure(context, 'Recipient Link was already used.', 410);
    return json(context, { recipientProfileId: link.recipientProfileId, destinationId: input.destinationId.trim() });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Recipient Link could not be consumed.', 409);
  }
});

app.patch('/api/organizations/:organizationId/suspension', async (context) => {
  try {
    const session = await sessionFromRequest(context.req.raw, context.env);
    if (!session) return failure(context, 'Authentication is required.', 401);
    const organizationId = context.req.param('organizationId');
    const control = drizzleControlDatabase(context.env.CONTROL_DB);
    const membership = await control.select({
      id: organizations.id,
      status: organizations.status,
      role: members.role,
    }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(and(
      eq(members.identityId, session.identity_id),
      eq(members.organizationId, organizationId),
      eq(members.state, 'active'),
    )).get();
    if (!membership || membership.role !== 'owner') return failure(context, 'Only an Owner can suspend or resume an Organization.', 403);
    const input = await context.req.json<{ suspended?: boolean }>();
    if (typeof input.suspended !== 'boolean') return failure(context, 'A suspension state is required.');
    const status = input.suspended ? 'suspended' : 'active';
    await control.update(organizations).set({ status, updatedAt: now() })
      .where(eq(organizations.id, organizationId)).run();
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
  return await drizzleControlDatabase(env.CONTROL_DB).select({
    id: sessions.id,
    identity_id: sessions.identityId,
    email: identities.email,
    display_name: identities.displayName,
  }).from(sessions).innerJoin(identities, eq(identities.id, sessions.identityId)).where(and(
    eq(sessions.id, id),
    gt(sessions.expiresAt, now()),
    isNull(sessions.revokedAt),
  )).get() ?? null;
};

/** Converts a fully authorized setup into a provisioning Organization without an extra Owner credential ceremony. */
const beginOrganizationProvisioning = async (env: Bindings, setup: OrganizationSetupRecord): Promise<void> => {
  if (setup.organizationId) {
    await attemptProvision(env, setup);
    return;
  }
  if (!setup.inboxAddress || !setup.ownerIdentityId) {
    throw new Error('Organization setup is missing its Automation Inbox or initial Owner.');
  }
  const organizationId = crypto.randomUUID();
  const bindingName = `ORG_${organizationId.replaceAll('-', '')}`;
  const createdAt = now();
  const control = drizzleControlDatabase(env.CONTROL_DB);
  await control.batch([
    control.insert(organizations).values({
      id: organizationId,
      name: setup.name,
      status: 'provisioning',
      bindingName,
      createdAt,
      updatedAt: createdAt,
    }),
    control.insert(members).values({
      organizationId,
      identityId: setup.ownerIdentityId,
      role: 'owner',
      state: 'pending',
      createdAt,
      updatedAt: createdAt,
    }),
    control.update(organizationSetups).set({
      state: 'provisioning',
      organizationId,
      bindingName,
      provisioningKey: crypto.randomUUID(),
      provisioningExpiresAt: expiresIn(PROVISIONING_WINDOW_MS),
      updatedAt: createdAt,
    }).where(eq(organizationSetups.id, setup.id)),
  ]);
  await createSetupOrganizationKey(env, organizationId);
  const current = await setupById(env, setup.id);
  if (current) await attemptProvision(env, current);
};

const attemptProvision = async (env: Bindings, setup: OrganizationSetupRecord): Promise<void> => {
  try {
    if (setup.organizationId) await createSetupOrganizationKey(env, setup.organizationId);
    await provisionSetup(env, setup);
  } catch (error) {
    await drizzleControlDatabase(env.CONTROL_DB).update(organizationSetups).set({
      state: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Provisioning failed.',
      updatedAt: now(),
    }).where(eq(organizationSetups.id, setup.id)).run();
  }
};

export const retryProvisioning = async (env: Bindings): Promise<void> => {
  const rows = await drizzleControlDatabase(env.CONTROL_DB).select().from(organizationSetups)
    .where(inArray(organizationSetups.state, ['provisioning', 'failed']))
    .orderBy(asc(organizationSetups.updatedAt)).limit(10).all();
  for (const setup of rows) {
    if (!setup.provisioningExpiresAt || Date.parse(setup.provisioningExpiresAt) <= Date.now()) {
      await expireSetup(env, setup);
      continue;
    }
    await attemptProvision(env, setup);
  }
};

const expireSetup = async (env: Bindings, setup: OrganizationSetupRecord): Promise<void> => {
  if (setup.credentialEnvelope) {
    try {
      const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
      const tokens = JSON.parse(await decrypt(JSON.parse(setup.credentialEnvelope), key, `setup-credential:${setup.id}`)) as { refreshToken?: string };
      if (tokens.refreshToken) await revokeGoogleToken(tokens.refreshToken);
    } catch {
      // Expiry must still erase local credentials when revocation is unavailable.
    }
  }
  await drizzleControlDatabase(env.CONTROL_DB).update(organizationSetups).set({
    state: 'expired',
    inboxAddress: null,
    googleSubject: null,
    grantedScopes: null,
    credentialEnvelope: null,
    historyId: null,
    ownerIdentityId: null,
    pkceVerifierEnvelope: '',
    provisioningPhase: null,
    errorMessage: 'Setup expired.',
    updatedAt: now(),
  }).where(eq(organizationSetups.id, setup.id)).run();
};

export { app };
