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

export const runDueJobs = async (env: Bindings): Promise<void> => {
  await retryProvisioning(env);
  await runEnabledAutomations(env);
};
