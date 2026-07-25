CREATE TABLE google_login_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_envelope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE google_automations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id) ON DELETE CASCADE,
  google_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  token_envelope TEXT NOT NULL,
  gmail_history_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automation_messages (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES google_automations(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  calendar_event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'skipped', 'exception')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_id, gmail_message_id)
);

CREATE INDEX google_login_states_expiry_idx ON google_login_states(expires_at);
CREATE INDEX automation_messages_automation_created_idx ON automation_messages(automation_id, created_at DESC);
