/**
 * The credential an outside agent presents to the MCP Server (ADR 0152).
 *
 * ADR 0106's run ceilings bound this engine's own agent loop and cannot bound a
 * caller's, so a Token carries its own rate and write limits.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const generateAccessToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Only the hash is stored, so a copy of the database is not a usable credential. */
export const accessTokenHash = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Reads the credential from the Authorization header alone. The MCP authorization
 * specification forbids an access token in the URI query string, and a token in a
 * URL is copied into logs and referrers by everything it passes through.
 */
export const presentedToken = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  return match?.[1] ?? null;
};

export interface CallLimitOutcome {
  admitted: boolean;
  reason?: string;
}

export const withinCallLimits = (input: {
  limits: { callsPerHour: number; writesPerDay: number };
  recent: ReadonlyArray<{ createdAt: string; isWrite: boolean }>;
  isWrite: boolean;
  at: Date;
}): CallLimitOutcome => {
  const now = input.at.getTime();
  const callsThisHour = input.recent.filter((call) => now - Date.parse(call.createdAt) < HOUR_MS).length;
  if (callsThisHour >= input.limits.callsPerHour) {
    return { admitted: false, reason: `This Access Token has spent its ${input.limits.callsPerHour} calls for the hour.` };
  }
  if (!input.isWrite) return { admitted: true };
  const writesToday = input.recent.filter((call) => call.isWrite && now - Date.parse(call.createdAt) < DAY_MS).length;
  if (writesToday >= input.limits.writesPerDay) {
    return { admitted: false, reason: `This Access Token has spent its ${input.limits.writesPerDay} writes for the day.` };
  }
  return { admitted: true };
};
