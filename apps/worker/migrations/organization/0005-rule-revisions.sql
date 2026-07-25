ALTER TABLE rules ADD COLUMN selection_policy TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rules ADD COLUMN routing_policy TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rule_revisions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  selection_policy TEXT NOT NULL,
  routing_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, revision)
);
