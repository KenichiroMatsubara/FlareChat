CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'recipient', 'line')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(list_id, value)
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
  source_list_id TEXT REFERENCES lists(id),
  recipient_list_id TEXT REFERENCES lists(id),
  line_list_id TEXT REFERENCES lists(id),
  schedule_minutes INTEGER NOT NULL DEFAULT 5,
  require_attendance INTEGER NOT NULL DEFAULT 0,
  deadline_days_before INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_messages (
  id TEXT PRIMARY KEY,
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_history_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  rule_id TEXT REFERENCES rules(id),
  source_message_id TEXT REFERENCES source_messages(id),
  google_event_id TEXT,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'cancelled', 'exception')),
  attendance_deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE attendance (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_item_id TEXT NOT NULL REFERENCES list_items(id),
  status TEXT NOT NULL DEFAULT 'unanswered' CHECK (status IN ('unanswered', 'attending', 'not_attending')),
  comment TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, recipient_item_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  source_message_id TEXT REFERENCES source_messages(id),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('google', 'line', 'ai')),
  label TEXT NOT NULL,
  credential TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  outcome TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX lists_kind_idx ON lists(kind);
CREATE INDEX rules_status_idx ON rules(status);
CREATE INDEX events_start_idx ON events(starts_at);
CREATE INDEX jobs_due_idx ON jobs(state, available_at);
CREATE INDEX exceptions_state_idx ON exceptions(state);
