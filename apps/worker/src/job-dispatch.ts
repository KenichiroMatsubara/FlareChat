/**
 * Executes claimed Jobs by kind.
 *
 * ADR 0073 makes a durable Job row the truth for every asynchronous unit of
 * work, but nothing was running the claimed rows: they were claimed and
 * discarded, so a Job could be recorded and never performed. A scheduled
 * reminder (ADR 0156) cannot be built on that, since accepting one and never
 * delivering it is exactly the failure this design refuses elsewhere.
 */

import { and, eq } from 'drizzle-orm';

import { claimDueJobs, completeJob, retryJob, type ClaimedJob } from './jobs';
import { createDatabaseAccess } from './database-access';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { accounts } from './storage/control-schema';
import { jobs } from './storage/account-schema';
import type { Bindings } from './types';

export type JobHandler = (input: {
  database: D1Database;
  accountId: string;
  job: ClaimedJob;
  payload: Record<string, unknown>;
}) => Promise<void>;

export interface JobDispatchOutcome {
  handled: number;
  failed: number;
  released: number;
}

/** Returns a claimed Job nobody handles, so an unrelated kind is not consumed by this pass. */
const releaseJob = async (database: D1Database, id: string, at: string): Promise<void> => {
  await drizzleAccountDatabase(database).update(jobs).set({ state: 'pending', updatedAt: at })
    .where(and(eq(jobs.id, id), eq(jobs.state, 'running'))).run();
};

export const dispatchClaimedJobs = async (input: {
  database: D1Database;
  accountId: string;
  claimed: readonly ClaimedJob[];
  handlers: Record<string, JobHandler>;
  at: string;
}): Promise<JobDispatchOutcome> => {
  const outcome: JobDispatchOutcome = { handled: 0, failed: 0, released: 0 };
  for (const job of input.claimed) {
    const handler = input.handlers[job.kind];
    if (!handler) {
      await releaseJob(input.database, job.id, input.at);
      outcome.released += 1;
      continue;
    }
    try {
      await handler({
        database: input.database,
        accountId: input.accountId,
        job,
        payload: JSON.parse(job.payload || '{}') as Record<string, unknown>,
      });
      await completeJob(input.database, job.id, input.at);
      outcome.handled += 1;
    } catch (error) {
      await retryJob(input.database, job, error instanceof Error ? error.message : 'Job failed.', input.at);
      outcome.failed += 1;
    }
  }
  return outcome;
};

export const dispatchDueAccountJobs = async (
  env: Bindings,
  dueAt: string,
  handlers: Record<string, JobHandler>,
): Promise<JobDispatchOutcome> => {
  const activeAccounts = await controlDatabase(env.CONTROL_DB).select({
    id: accounts.id,
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(eq(accounts.status, 'active')).all();
  const totals: JobDispatchOutcome = { handled: 0, failed: 0, released: 0 };
  const databases = createDatabaseAccess(env);
  for (const account of activeAccounts) {
    if (!account.databaseId) continue;
    const database = await databases.open({
      kind: 'organization',
      bindingName: account.bindingName,
      databaseId: account.databaseId,
    });
    const claimed = await claimDueJobs(database.raw, dueAt);
    const outcome = await dispatchClaimedJobs({ database: database.raw, accountId: account.id, claimed, handlers, at: dueAt });
    totals.handled += outcome.handled;
    totals.failed += outcome.failed;
    totals.released += outcome.released;
  }
  return totals;
};
