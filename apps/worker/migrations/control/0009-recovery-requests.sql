CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'executing', 'completed', 'failed')),
  requested_by_identity_id TEXT NOT NULL REFERENCES identities(id),
  executed_by_identity_id TEXT REFERENCES identities(id),
  error_message TEXT,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  UNIQUE(organization_id, idempotency_key)
);

CREATE INDEX recovery_requests_org_state_idx ON recovery_requests(organization_id, state, created_at);
