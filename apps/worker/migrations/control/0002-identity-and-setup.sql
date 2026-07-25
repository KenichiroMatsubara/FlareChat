CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, identity_id)
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_jwk TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE organization_setups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_google', 'awaiting_passkey', 'provisioning', 'active', 'expired', 'failed')),
  oauth_state_hash TEXT NOT NULL,
  pkce_verifier_envelope TEXT NOT NULL,
  passkey_challenge_hash TEXT,
  inbox_address TEXT UNIQUE,
  google_subject TEXT,
  granted_scopes TEXT,
  credential_envelope TEXT,
  history_id TEXT,
  owner_identity_id TEXT REFERENCES identities(id),
  organization_id TEXT UNIQUE REFERENCES organizations(id),
  database_id TEXT,
  binding_name TEXT,
  provisioning_key TEXT,
  error_message TEXT,
  expires_at TEXT NOT NULL,
  provisioning_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE organization_keys (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  master_key_version TEXT NOT NULL,
  wrapped_key_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX members_identity_idx ON members(identity_id, state);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at, revoked_at);
CREATE INDEX setups_state_expiry_idx ON organization_setups(state, expires_at);
CREATE INDEX passkey_challenges_expiry_idx ON passkey_challenges(expires_at);
