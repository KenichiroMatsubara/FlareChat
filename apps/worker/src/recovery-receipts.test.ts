import { describe, expect, it } from 'vitest';

import { masterKey } from './cryptography';
import { readRecoveryReceipt, writeRecoveryReceipt } from './recovery-receipts';

describe('Recovery Receipts', () => {
  it('stores a success receipt encrypted in R2 and reconstructs it by idempotency key', async () => {
    const values = new Map<string, string>();
    const bucket = {
      put: async (key: string, value: string) => { values.set(key, value); return null; },
      get: async (key: string) => values.has(key) ? { text: async () => values.get(key)! } : null,
    } as unknown as R2Bucket;
    const key = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const receipt = { organizationId: 'organization-1', idempotencyKey: 'calendar:event-1:recipient-1', effectType: 'calendar' as const, externalId: 'google-event-1', destinationFingerprint: 'sha256:abc', succeededAt: '2026-07-25T00:00:00.000Z' };

    const path = await writeRecoveryReceipt({ bucket, organizationKey: key, receipt });

    expect(values.get(path)).not.toContain('google-event-1');
    await expect(readRecoveryReceipt({ bucket, organizationKey: key, organizationId: 'organization-1', idempotencyKey: 'calendar:event-1:recipient-1' })).resolves.toEqual(receipt);
  });
});
