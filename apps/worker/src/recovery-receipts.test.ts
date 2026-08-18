import { afterEach, describe, expect, it } from 'vitest';

import { archiveExpiredDeliveryRecords } from './delivery-archive';
import { masterKey } from './cryptography';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt, writeRecoveryReceipt } from './recovery-receipts';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Recovery Receipts', () => {
  it('stores a successful external effect encrypted and retrieves it by idempotency key', async () => {
    const r2 = createMemoryR2();
    const key = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const receipt = {
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
      effectType: 'calendar' as const,
      externalId: 'google-event-1',
      destinationFingerprint: 'sha256:abc',
      succeededAt: '2026-07-25T00:00:00.000Z',
    };

    const path = await writeRecoveryReceipt({ bucket: r2.bucket, accountKey: key, receipt });

    expect(r2.object(path)).not.toContain('google-event-1');
    await expect(readRecoveryReceipt({
      bucket: r2.bucket,
      accountKey: key,
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
    })).resolves.toEqual(receipt);
  });

  it('restores a durable successful Delivery Record that participates in normal retention', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1' });

    await restoreDeliveryRecordFromReceipt(database.binding, {
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
      effectType: 'calendar',
      externalId: 'google-event-1',
      destinationFingerprint: 'sha256:abc',
      succeededAt: '2026-07-25T00:00:00.000Z',
    });

    await expect(archiveExpiredDeliveryRecords({
      database: database.binding,
      bucket: createMemoryR2().bucket,
      accountKey: await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      accountId: 'organization-1',
      before: '2099-01-01T00:00:00.000Z',
    })).resolves.toBe(1);
  });
});
