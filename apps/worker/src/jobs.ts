import type { Bindings } from './types';

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
}

interface JobPayload {
  organizationId: string;
}

export const runDueJobs = async (env: Bindings): Promise<void> => {
  const now = new Date().toISOString();
  const result = await env.ORG_DB.prepare(
    `SELECT id, kind, payload, attempts FROM jobs
     WHERE state = 'pending' AND available_at <= ? ORDER BY available_at LIMIT 20`,
  )
    .bind(now)
    .all<JobRow>();

  for (const job of result.results) {
    await runJob(env, job);
  }
};

const runJob = async (env: Bindings, job: JobRow): Promise<void> => {
  await env.ORG_DB.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), job.id)
    .run();

  try {
    if (job.kind !== 'gmail_sync') throw new Error(`Unsupported job kind: ${job.kind}`);
    const payload = JSON.parse(job.payload) as JobPayload;
    await markSync(env.ORG_DB, payload.organizationId);
    await env.ORG_DB.prepare("UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), job.id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job failed';
    const delay = Math.min(60, 2 ** job.attempts);
    const availableAt = new Date(Date.now() + delay * 60_000).toISOString();
    await env.ORG_DB.prepare(
      `UPDATE jobs SET state = 'pending', attempts = attempts + 1, last_error = ?,
       available_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(message, availableAt, new Date().toISOString(), job.id)
      .run();
  }
};

const markSync = async (database: D1Database, organizationId: string): Promise<void> => {
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_sync_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(now, now)
    .run();

  const rules = await database
    .prepare(
      `SELECT id FROM rules WHERE organization_id = ? AND status = 'active'
       AND id NOT IN (
         SELECT json_extract(payload, '$.ruleId') FROM jobs
         WHERE kind = 'rule_sync' AND state IN ('pending', 'running')
       )`,
    )
    .bind(organizationId)
    .all<{ id: string }>();

  if (rules.results.length === 0) return;
  const statements = rules.results.map((rule) => {
    const id = crypto.randomUUID();
    return database
      .prepare(
        `INSERT INTO jobs (id, kind, payload, state, available_at, created_at, updated_at)
         VALUES (?, 'rule_sync', ?, 'completed', ?, ?, ?)`,
      )
      .bind(id, JSON.stringify({ organizationId, ruleId: rule.id }), now, now, now);
  });
  await database.batch(statements);
};
