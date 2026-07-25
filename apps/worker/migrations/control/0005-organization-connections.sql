CREATE TABLE organization_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('line', 'ai')),
  label TEXT NOT NULL,
  credential TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, kind)
);

CREATE INDEX organization_connections_organization_idx ON organization_connections(organization_id, kind);
