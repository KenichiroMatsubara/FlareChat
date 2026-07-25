CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inbox_address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'failed')),
  database_id TEXT,
  binding_name TEXT NOT NULL DEFAULT 'UNBOUND',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE setup_sessions (
  id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL,
  inbox_address TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX organizations_status_idx ON organizations(status);
CREATE INDEX setup_sessions_expiry_idx ON setup_sessions(expires_at);
