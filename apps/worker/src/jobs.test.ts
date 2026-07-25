import { describe, expect, it } from 'vitest';

import { enqueueJob } from './jobs';

describe('Durable Jobs', () => {
  it('persists an Organization job with a retryable state and idempotency key', async () => {
    const writes: unknown[][] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({ run: async () => { writes.push([sql, ...values]); return { meta: { changes: 1 } }; } }),
      }),
    } as unknown as D1Database;

    const job = await enqueueJob(database, { kind: 'calendar_delivery', payload: { eventId: 'event-1' }, idempotencyKey: 'calendar:event-1:recipient-1' });

    expect(job).toMatchObject({ kind: 'calendar_delivery', state: 'pending', attempts: 0, idempotencyKey: 'calendar:event-1:recipient-1' });
    expect(writes[0]?.[0]).toContain('INSERT OR IGNORE INTO jobs');
  });
});
