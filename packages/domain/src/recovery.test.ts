import { describe, expect, it } from 'vitest';

import { shouldWriteRecoveryReceipt } from './recovery';

describe('Recovery Receipts', () => {
  it('captures only successful external effects for post-restore idempotency reconstruction', () => {
    expect(shouldWriteRecoveryReceipt('succeeded')).toBe(true);
    expect(shouldWriteRecoveryReceipt('failed')).toBe(false);
    expect(shouldWriteRecoveryReceipt('pending')).toBe(false);
  });
});
