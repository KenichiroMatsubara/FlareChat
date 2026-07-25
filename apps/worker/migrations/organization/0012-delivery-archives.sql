CREATE TABLE IF NOT EXISTS delivery_archives (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  archived_before TEXT NOT NULL,
  created_at TEXT NOT NULL
);
