export const MAX_DELIVERY_ATTEMPTS = 5;
export const MAX_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type RetryDecision = { retryAt: string } | { terminal: true };

export const nextRetry = (input: { attempts: number; now: string; retryAfterSeconds?: number }): RetryDecision => {
  if (input.attempts >= MAX_DELIVERY_ATTEMPTS) return { terminal: true };
  const delay = input.retryAfterSeconds === undefined
    ? Math.min(2 ** Math.max(0, input.attempts - 1) * 60_000, MAX_RETRY_WINDOW_MS)
    : input.retryAfterSeconds * 1_000;
  return { retryAt: new Date(Date.parse(input.now) + Math.min(delay, MAX_RETRY_WINDOW_MS)).toISOString() };
};
