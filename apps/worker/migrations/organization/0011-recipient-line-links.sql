CREATE TABLE IF NOT EXISTS recipient_link_tokens (
  token TEXT PRIMARY KEY,
  recipient_profile_id TEXT NOT NULL REFERENCES recipient_profiles(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipient_line_destinations (
  recipient_profile_id TEXT NOT NULL REFERENCES recipient_profiles(id) ON DELETE CASCADE,
  line_destination_id TEXT NOT NULL REFERENCES line_destinations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(recipient_profile_id, line_destination_id)
);
