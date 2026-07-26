CREATE TABLE connections_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('line', 'ai')),
  label TEXT NOT NULL,
  credential TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO connections_next (id, kind, label, credential, status, created_at, updated_at)
SELECT id, kind, label, credential, status, created_at, updated_at
FROM connections
WHERE kind IN ('line', 'ai');

CREATE TABLE line_destinations_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections_next(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'room')),
  status TEXT NOT NULL DEFAULT 'discovered',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, destination_id)
);

INSERT INTO line_destinations_next (id, connection_id, destination_id, kind, status, discovered_at, updated_at)
SELECT destination.id, destination.connection_id, destination.destination_id, destination.kind,
       destination.status, destination.discovered_at, destination.updated_at
FROM line_destinations destination
JOIN connections connection ON connection.id = destination.connection_id
WHERE connection.kind IN ('line', 'ai');

DROP TABLE line_destinations;
DROP TABLE connections;
ALTER TABLE connections_next RENAME TO connections;
ALTER TABLE line_destinations_next RENAME TO line_destinations;

CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO jobs_next (id, kind, payload, state, attempts, available_at, idempotency_key, last_error, created_at, updated_at)
SELECT id, kind, payload, state, attempts, available_at, idempotency_key, last_error, created_at, updated_at
FROM jobs
WHERE idempotency_key IS NOT NULL;

DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
CREATE INDEX jobs_due_idx ON jobs(state, available_at);

DROP TABLE IF EXISTS schema_migrations;
