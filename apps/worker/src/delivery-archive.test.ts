import { afterEach, describe, expect, it } from 'vitest';

import { masterKey } from './cryptography';
import { archiveExpiredDeliveryRecords } from './delivery-archive';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, seedDeliveryRecord } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const archiveKey = (): Promise<CryptoKey> =>
  masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

describe('Delivery retention archive', () => {
  it('moves expired Delivery Records into an encrypted R2 archive exactly once', async () => {
    const database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    openDatabases.push(database);
    seedDeliveryRecord(database, {
      id: 'delivery-1',
      destination: 'guest@example.com',
      externalId: 'google-event-1',
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const first = await archiveExpiredDeliveryRecords({
      database: database.binding,
      bucket: r2.bucket,
      accountKey: await archiveKey(),
      accountId: 'organization-1',
      before: '2026-01-01T00:00:00.000Z',
    });
    const second = await archiveExpiredDeliveryRecords({
      database: database.binding,
      bucket: r2.bucket,
      accountKey: await archiveKey(),
      accountId: 'organization-1',
      before: '2026-01-01T00:00:00.000Z',
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(r2.keys()).toHaveLength(1);
    expect(r2.object(r2.keys()[0]!)).not.toContain('guest@example.com');
  });

  it('leaves expired Delivery Records recoverable when R2 persistence fails', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedDeliveryRecord(database, {
      id: 'delivery-1',
      destination: 'guest@example.com',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const input = {
      database: database.binding,
      accountKey: await archiveKey(),
      accountId: 'organization-1',
      before: '2026-01-01T00:00:00.000Z',
    };

    await expect(archiveExpiredDeliveryRecords({
      ...input,
      bucket: createMemoryR2(new Error('R2 unavailable')).bucket,
    })).rejects.toThrow('R2 unavailable');

    await expect(archiveExpiredDeliveryRecords({
      ...input,
      bucket: createMemoryR2().bucket,
    })).resolves.toBe(1);
  });
});
