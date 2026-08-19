import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchClaimedJobs } from './job-dispatch';
import { claimDueJobs, enqueueJob } from './jobs';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

const dueAt = '2099-01-01T00:00:00.000Z';
const openDatabases: TestD1Database[] = [];

const accountDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  return database;
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Job dispatch', () => {
  it('runs a Job of a handled kind and finishes it', async () => {
    const database = accountDatabase();
    await enqueueJob(database.binding, { kind: 'mcp.reminder', payload: { text: 'hi' }, idempotencyKey: 'reminder-1' });
    const claimed = await claimDueJobs(database.binding, dueAt);
    const handler = vi.fn(async () => undefined);

    const outcome = await dispatchClaimedJobs({
      database: database.binding, accountId: 'organization-1', claimed, handlers: { 'mcp.reminder': handler }, at: dueAt,
    });

    expect(outcome).toEqual({ handled: 1, failed: 0, released: 0 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'hi' } }));
    expect(database.rows<{ state: string }>('SELECT state FROM jobs')).toEqual([{ state: 'succeeded' }]);
  });

  it('returns a Job nobody handles rather than consuming it', async () => {
    const database = accountDatabase();
    await enqueueJob(database.binding, { kind: 'attendance-reminder', payload: {}, idempotencyKey: 'reminder-2' });
    const claimed = await claimDueJobs(database.binding, dueAt);

    const outcome = await dispatchClaimedJobs({
      database: database.binding, accountId: 'organization-1', claimed, handlers: {}, at: dueAt,
    });

    expect(outcome.released).toBe(1);
    expect(database.rows<{ state: string }>('SELECT state FROM jobs')).toEqual([{ state: 'pending' }]);
  });

  it('returns a failed Job to the queue instead of losing it', async () => {
    const database = accountDatabase();
    await enqueueJob(database.binding, { kind: 'mcp.reminder', payload: {}, idempotencyKey: 'reminder-3' });
    const claimed = await claimDueJobs(database.binding, dueAt);

    const outcome = await dispatchClaimedJobs({
      database: database.binding,
      accountId: 'organization-1',
      claimed,
      handlers: { 'mcp.reminder': async () => { throw new Error('LINE push failed.'); } },
      at: dueAt,
    });

    expect(outcome.failed).toBe(1);
    expect(database.rows<{ state: string; attempts: number; last_error: string }>('SELECT state, attempts, last_error FROM jobs'))
      .toEqual([{ state: 'pending', attempts: 1, last_error: 'LINE push failed.' }]);
  });
});
