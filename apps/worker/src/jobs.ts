import { retryProvisioning } from './api';
import { runEnabledAutomations } from './automation';
import type { Bindings } from './types';

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
  await database.prepare(
    "INSERT OR IGNORE INTO jobs (id, kind, payload, state, attempts, available_at, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)",
  ).bind(job.id, job.kind, JSON.stringify(job.payload), job.availableAt, job.idempotencyKey, job.availableAt, job.availableAt).run();
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
  const rows = await database.prepare(
    "SELECT id, kind, payload, attempts, idempotency_key FROM jobs WHERE state = 'pending' AND available_at <= ? ORDER BY available_at LIMIT 50",
  ).bind(dueAt).all<{ id: string; kind: string; payload: string; attempts: number; idempotency_key: string }>();
  const claimed: ClaimedJob[] = [];
  for (const row of rows.results) {
    const result = await database.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'pending'")
      .bind(dueAt, row.id).run();
    if (result.meta.changes > 0) claimed.push({ id: row.id, kind: row.kind, payload: row.payload, attempts: row.attempts, idempotencyKey: row.idempotency_key });
  }
  return claimed;
};

/** Finds due Jobs in every active Organization database; Queue messages never own job state. */
export const recoverDueOrganizationJobs = async (env: Bindings, dueAt: string): Promise<ClaimedJob[]> => {
  const organizations = await env.CONTROL_DB.prepare("SELECT binding_name FROM organizations WHERE status = 'active' AND database_id IS NOT NULL")
    .all<{ binding_name: string }>();
  const claimed: ClaimedJob[] = [];
  for (const organization of organizations.results) {
    const database = (env as unknown as Record<string, unknown>)[organization.binding_name];
    if (!database || typeof database !== 'object') continue;
    claimed.push(...await claimDueJobs(database as D1Database, dueAt));
  }
  return claimed;
};

export const runDueJobs = async (env: Bindings): Promise<void> => {
  await retryProvisioning(env);
  await recoverDueOrganizationJobs(env, new Date().toISOString());
  await runEnabledAutomations(env);
};
