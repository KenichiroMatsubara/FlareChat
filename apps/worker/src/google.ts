import { randomToken, sha256, toBase64Url, encodeText, toArrayBuffer } from './encoding';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/drive.file',
] as const;

const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

const normalizedGoogleScopes = (scopes: Iterable<string>): Set<string> =>
  new Set(Array.from(scopes, (scope) => GOOGLE_SCOPE_ALIASES[scope] ?? scope));

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  tokenType: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string;
}

export const createPkce = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = randomToken(64);
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(verifier))));
  return { verifier, challenge };
};

export const hasCompleteGoogleGrant = (scopes: Iterable<string>): boolean => {
  const granted = normalizedGoogleScopes(scopes);
  return GOOGLE_SCOPES.every((scope) => granted.has(scope));
};

export const missingGoogleScopes = (scopes: Iterable<string>): string[] => {
  const granted = normalizedGoogleScopes(scopes);
  return GOOGLE_SCOPES.filter((scope) => !granted.has(scope));
};

export const googleAuthorizationUrl = (input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
}): string => {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: (input.scopes ?? GOOGLE_SCOPES).join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
  }).toString();
  return url.toString();
};

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export const exchangeGoogleCode = async (input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokenSet> => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = await response.json() as GoogleTokenResponse;
  if (!response.ok || !body.access_token || !body.refresh_token || !body.scope || !body.expires_in) {
    throw new Error(body.error_description ?? body.error ?? 'Google authorization failed.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1_000).toISOString(),
    scopes: body.scope.split(' ').filter(Boolean),
    tokenType: body.token_type ?? 'Bearer',
  };
};

export const refreshGoogleToken = async (input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokenSet> => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json() as GoogleTokenResponse;
  if (!response.ok || !body.access_token || !body.expires_in) {
    throw new Error(body.error_description ?? body.error ?? 'Google token refresh failed.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? input.refreshToken,
    expiresAt: new Date(Date.now() + body.expires_in * 1_000).toISOString(),
    scopes: body.scope?.split(' ').filter(Boolean) ?? [...GOOGLE_SCOPES],
    tokenType: body.token_type ?? 'Bearer',
  };
};

export const fetchGoogleIdentity = async (accessToken: string): Promise<GoogleIdentity> => {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json() as { sub?: string; email?: string; name?: string };
  if (!response.ok || !body.sub || !body.email) throw new Error('Google identity could not be verified.');
  return { subject: body.sub, email: body.email.toLowerCase(), displayName: body.name ?? body.email };
};

export const fetchGmailHistoryId = async (accessToken: string): Promise<string> => {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json() as { historyId?: string };
  if (!response.ok || !body.historyId) throw new Error('Gmail history position could not be captured.');
  return body.historyId;
};

export const revokeGoogleToken = async (token: string): Promise<void> => {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
};

export const opaqueStateHash = (state: string): Promise<string> => sha256(state);
