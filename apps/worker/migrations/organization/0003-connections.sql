CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('line', 'ai')),
  label TEXT NOT NULL,
  credential TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
