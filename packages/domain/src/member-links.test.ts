import { describe, expect, it } from 'vitest';

import { canConsumeMemberLink } from './member-links';

describe('Recipient Links', () => {
  it('accepts a short-lived unused link once and rejects expired or previously used links', () => {
    expect(canConsumeMemberLink({ usedAt: null, expiresAt: '2026-07-25T01:00:00.000Z', now: '2026-07-25T00:59:59.000Z' })).toBe(true);
    expect(canConsumeMemberLink({ usedAt: '2026-07-25T00:30:00.000Z', expiresAt: '2026-07-25T01:00:00.000Z', now: '2026-07-25T00:40:00.000Z' })).toBe(false);
    expect(canConsumeMemberLink({ usedAt: null, expiresAt: '2026-07-25T01:00:00.000Z', now: '2026-07-25T01:00:00.000Z' })).toBe(false);
  });
});
