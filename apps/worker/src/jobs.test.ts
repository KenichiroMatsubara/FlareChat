import { describe, expect, it } from 'vitest';

import { claimDueJobs, enqueueJob, recoverDueOrganizationJobs } from './jobs';

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

describe('Organization Job recovery', () => {
  it('scans every active Organization binding for due Jobs after Queue loss', async () => {
    const controlDatabase = { prepare: (_sql: string) => ({ all: async () => ({ results: [{ binding_name: 'ORG_ONE' }] }) }) } as unknown as D1Database;
    const organizationDatabase = {
      prepare: (_sql: string) => ({ bind: (..._values: unknown[]) => ({ all: async () => ({ results: [] }) }) }),
    } as unknown as D1Database;

    await expect(recoverDueOrganizationJobs({ CONTROL_DB: controlDatabase, ORG_ONE: organizationDatabase } as unknown as Parameters<typeof recoverDueOrganizationJobs>[0], '2026-07-25T00:00:00.000Z')).resolves.toEqual([]);
  });
});

describe('Cron due scans', () => {
  it('rediscovers pending Jobs after a Queue hint is lost and claims each one once', async () => {
    const writes: unknown[][] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: sql.includes('SELECT') ? [{ id: 'job-1', kind: 'calendar_delivery', payload: '{}', attempts: 0, idempotency_key: 'key-1' }] : [] }),
          run: async () => { writes.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;

    const jobs = await claimDueJobs(database, '2026-07-25T00:00:00.000Z');

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'job-1', kind: 'calendar_delivery' });
    expect(writes[0]).toContain('job-1');
  });
});
