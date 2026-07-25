CREATE TABLE IF NOT EXISTS event_overrides (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_identity_id TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_overrides_event_idx ON event_overrides(event_id, created_at);
