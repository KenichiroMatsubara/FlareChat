CREATE TABLE google_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'automation_inbox'),
  google_subject TEXT NOT NULL UNIQUE,
  inbox_address TEXT NOT NULL UNIQUE,
  granted_scopes TEXT NOT NULL,
  token_envelope TEXT NOT NULL,
  gmail_history_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'reauthentication_required', 'disconnected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
