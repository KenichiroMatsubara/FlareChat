ALTER TABLE passkeys ADD COLUMN revoked_at TEXT;

CREATE INDEX IF NOT EXISTS passkeys_active_identity_idx ON passkeys(identity_id, revoked_at);
