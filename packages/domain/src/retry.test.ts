import { describe, expect, it } from 'vitest';

import { nextRetry } from './retry';

describe('delivery retry policy', () => {
  it('uses Retry-After when present and otherwise bounds exponential backoff to five attempts in 24 hours', () => {
    expect(nextRetry({ attempts: 1, now: '2026-07-25T00:00:00.000Z', retryAfterSeconds: 120 })).toEqual({ retryAt: '2026-07-25T00:02:00.000Z' });
    expect(nextRetry({ attempts: 5, now: '2026-07-25T00:00:00.000Z' })).toEqual({ terminal: true });
    expect(nextRetry({ attempts: 2, now: '2026-07-25T00:00:00.000Z' })).toEqual({ retryAt: '2026-07-25T00:02:00.000Z' });
  });
});
