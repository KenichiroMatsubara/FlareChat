ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_idx ON jobs(idempotency_key);
