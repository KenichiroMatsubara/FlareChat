CREATE TABLE members_next (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, identity_id)
);

INSERT INTO members_next (organization_id, identity_id, role, state, created_at, updated_at)
SELECT organization_id, identity_id, role, state, created_at, updated_at FROM members;

DROP TABLE members;
ALTER TABLE members_next RENAME TO members;
CREATE INDEX members_identity_idx ON members(identity_id, state);
