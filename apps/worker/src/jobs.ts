import { organizationDatabase } from './organization-db';
import type { Bindings } from './types';
import { nextRetry } from '@mail/domain';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizations } from './storage/control-schema';
import { jobs } from './storage/organization-schema';

export interface DurableJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  state: 'pending';
  attempts: number;
  availableAt: string;
  idempotencyKey: string;
}

/** Adds a durable Organization Job; a duplicate wake-up cannot duplicate its external effect. */
export const enqueueJob = async (
  database: D1Database,
  input: { kind: string; payload: Record<string, unknown>; idempotencyKey: string },
): Promise<DurableJob> => {
  const job: DurableJob = {
    id: crypto.randomUUID(),
    kind: input.kind,
    payload: input.payload,
    state: 'pending',
    attempts: 0,
    availableAt: new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
  };
  await drizzleOrganizationDatabase(database).insert(jobs).values({
    ...job,
    payload: JSON.stringify(job.payload),
    createdAt: job.availableAt,
    updatedAt: job.availableAt,
  }).onConflictDoNothing().run();
  return job;
};

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  idempotencyKey: string;
}

/** Reclaims due work from D1 so Queue delivery remains only a wake-up hint. */
export const claimDueJobs = async (database: D1Database, dueAt: string): Promise<ClaimedJob[]> => {
  const db = drizzleOrganizationDatabase(database);
  const rows = await db.select({
    id: jobs.id,
    kind: jobs.kind,
    payload: jobs.payload,
    attempts: jobs.attempts,
    idempotencyKey: jobs.idempotencyKey,
  }).from(jobs).where(and(eq(jobs.state, 'pending'), lte(jobs.availableAt, dueAt)))
    .orderBy(asc(jobs.availableAt)).limit(50).all();
  const claimed: ClaimedJob[] = [];
  for (const row of rows) {
    const result = await db.update(jobs).set({ state: 'running', updatedAt: dueAt })
      .where(and(eq(jobs.id, row.id), eq(jobs.state, 'pending'))).run();
    if (result.meta.changes > 0) claimed.push(row);
  }
  return claimed;
};

/** Finalizes a claimed Job once its idempotent external effect has succeeded. */
export const completeJob = async (database: D1Database, id: string, completedAt: string): Promise<void> => {
  await drizzleOrganizationDatabase(database).update(jobs).set({ state: 'succeeded', updatedAt: completedAt })
    .where(and(eq(jobs.id, id), eq(jobs.state, 'running'))).run();
};

export type JobRetryResult = { state: 'pending'; attempts: number; availableAt: string } | { state: 'failed'; attempts: number };

/** Returns a failed claim to the durable queue or records its bounded terminal failure. */
export const retryJob = async (
  database: D1Database,
  job: Pick<ClaimedJob, 'id' | 'attempts'>,
  error: string,
  failedAt: string,
): Promise<JobRetryResult> => {
  const attempts = job.attempts + 1;
  const retry = nextRetry({ attempts, now: failedAt });
  if ('terminal' in retry) {
    await drizzleOrganizationDatabase(database).update(jobs).set({ state: 'failed', attempts, lastError: error, updatedAt: failedAt })
      .where(and(eq(jobs.id, job.id), eq(jobs.state, 'running'))).run();
    return { state: 'failed', attempts };
  }
  await drizzleOrganizationDatabase(database).update(jobs).set({ state: 'pending', attempts, availableAt: retry.retryAt, lastError: error, updatedAt: failedAt })
    .where(and(eq(jobs.id, job.id), eq(jobs.state, 'running'))).run();
  return { state: 'pending', attempts, availableAt: retry.retryAt };
};

/** Finds due Jobs in every active Organization database; Queue messages never own job state. */
export const recoverDueOrganizationJobs = async (env: Bindings, dueAt: string): Promise<ClaimedJob[]> => {
  const activeOrganizations = await controlDatabase(env.CONTROL_DB).select({
    bindingName: organizations.bindingName,
    databaseId: organizations.databaseId,
  }).from(organizations).where(and(eq(organizations.status, 'active'), isNotNull(organizations.databaseId))).all();
  const claimed: ClaimedJob[] = [];
  for (const organization of activeOrganizations) {
    const database = organizationDatabase(env, organization.bindingName, organization.databaseId);
    if (!database) continue;
    claimed.push(...await claimDueJobs(database, dueAt));
  }
  return claimed;
};
