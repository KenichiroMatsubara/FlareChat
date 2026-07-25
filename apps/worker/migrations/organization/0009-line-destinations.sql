CREATE TABLE IF NOT EXISTS line_destinations (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'room')),
  status TEXT NOT NULL DEFAULT 'discovered',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, destination_id)
);
