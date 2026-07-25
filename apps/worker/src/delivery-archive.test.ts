import { describe, expect, it } from 'vitest';

import { masterKey } from './cryptography';
import { archiveExpiredDeliveryRecords } from './delivery-archive';

describe('Delivery retention archive', () => {
  it('encrypts expired Delivery Records into R2 before deleting their hot D1 copies', async () => {
    const writes: string[] = [];
    let object = '';
    const database = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({ all: async () => ({ results: sql.includes('SELECT') ? [{ id: 'delivery-1', event_id: 'event-1', channel: 'calendar', destination: 'guest@example.com', outcome: 'succeeded', external_id: 'google-event-1', created_at: '2025-01-01T00:00:00.000Z' }] : [] }) }),
      }),
      batch: async (statements: Array<{ run: () => Promise<unknown> }>) => { writes.push(String(statements.length)); return []; },
    } as unknown as D1Database;
    const bucket = { put: async (_key: string, value: string) => { object = value; return null; } } as unknown as R2Bucket;

    await expect(archiveExpiredDeliveryRecords({ database, bucket, organizationKey: await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), organizationId: 'organization-1', before: '2026-01-01T00:00:00.000Z' })).resolves.toBe(1);
    expect(object).not.toContain('guest@example.com');
    expect(writes).toEqual(['2']);
  });
});
