DROP TABLE IF EXISTS automation_messages;
DROP TABLE IF EXISTS google_automations;
DROP TABLE IF EXISTS organization_connections;
DROP TABLE IF EXISTS passkey_challenges;
DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS setup_sessions;
DROP TABLE IF EXISTS gemini_oauth_states;

CREATE TABLE organizations_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'failed')),
  database_id TEXT,
  binding_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO organizations_next (id, name, status, database_id, binding_name, created_at, updated_at)
SELECT id, name, status, database_id, binding_name, created_at, updated_at
FROM organizations;

CREATE TABLE members_next (
  organization_id TEXT NOT NULL REFERENCES organizations_next(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, identity_id)
);

INSERT INTO members_next (organization_id, identity_id, role, state, created_at, updated_at)
SELECT organization_id, identity_id, role, state, created_at, updated_at
FROM members;

CREATE TABLE organization_keys_next (
  organization_id TEXT PRIMARY KEY REFERENCES organizations_next(id) ON DELETE CASCADE,
  master_key_version TEXT NOT NULL,
  wrapped_key_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO organization_keys_next (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at)
SELECT organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at
FROM organization_keys;

CREATE TABLE organization_setups_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_google', 'awaiting_name', 'provisioning', 'active', 'expired', 'failed')),
  oauth_state_hash TEXT NOT NULL,
  pkce_verifier_envelope TEXT NOT NULL,
  inbox_address TEXT UNIQUE,
  google_subject TEXT,
  granted_scopes TEXT,
  credential_envelope TEXT,
  history_id TEXT,
  owner_identity_id TEXT REFERENCES identities(id),
  organization_id TEXT UNIQUE REFERENCES organizations_next(id),
  database_id TEXT,
  binding_name TEXT,
  provisioning_key TEXT,
  provisioning_phase TEXT,
  error_message TEXT,
  expires_at TEXT NOT NULL,
  provisioning_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO organization_setups_next (
  id, name, state, oauth_state_hash, pkce_verifier_envelope, inbox_address,
  google_subject, granted_scopes, credential_envelope, history_id,
  owner_identity_id, organization_id, database_id, binding_name,
  provisioning_key, provisioning_phase, error_message, expires_at,
  provisioning_expires_at, created_at, updated_at
)
SELECT
  id,
  name,
  CASE state WHEN 'awaiting_passkey' THEN 'awaiting_name' ELSE state END,
  oauth_state_hash,
  pkce_verifier_envelope,
  inbox_address,
  google_subject,
  granted_scopes,
  credential_envelope,
  history_id,
  owner_identity_id,
  organization_id,
  database_id,
  binding_name,
  provisioning_key,
  provisioning_phase,
  error_message,
  expires_at,
  provisioning_expires_at,
  created_at,
  updated_at
FROM organization_setups;

CREATE TABLE recovery_requests_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations_next(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'executing', 'completed', 'failed')),
  requested_by_identity_id TEXT NOT NULL REFERENCES identities(id),
  executed_by_identity_id TEXT REFERENCES identities(id),
  error_message TEXT,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  UNIQUE (organization_id, idempotency_key)
);

INSERT INTO recovery_requests_next (
  id, organization_id, idempotency_key, state, requested_by_identity_id,
  executed_by_identity_id, error_message, created_at, executed_at
)
SELECT
  id, organization_id, idempotency_key, state, requested_by_identity_id,
  executed_by_identity_id, error_message, created_at, executed_at
FROM recovery_requests;

DROP TABLE recovery_requests;
DROP TABLE organization_setups;
DROP TABLE organization_keys;
DROP TABLE members;
DROP TABLE organizations;

ALTER TABLE organizations_next RENAME TO organizations;
ALTER TABLE members_next RENAME TO members;
ALTER TABLE organization_keys_next RENAME TO organization_keys;
ALTER TABLE organization_setups_next RENAME TO organization_setups;
ALTER TABLE recovery_requests_next RENAME TO recovery_requests;

CREATE INDEX organizations_status_idx ON organizations(status);
CREATE INDEX members_identity_idx ON members(identity_id, state);
CREATE INDEX setups_state_expiry_idx ON organization_setups(state, expires_at);
CREATE INDEX recovery_requests_org_state_idx ON recovery_requests(organization_id, state, created_at);

CREATE TABLE gemini_oauth_states (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_envelope TEXT NOT NULL,
  configuration_envelope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
