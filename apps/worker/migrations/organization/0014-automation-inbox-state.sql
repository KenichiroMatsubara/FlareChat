ALTER TABLE google_connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE google_connections ADD COLUMN last_synced_at TEXT;
ALTER TABLE google_connections ADD COLUMN last_error TEXT;
