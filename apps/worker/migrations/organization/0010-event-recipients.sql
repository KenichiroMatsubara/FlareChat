CREATE TABLE IF NOT EXISTS event_recipients (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_profile_id TEXT NOT NULL REFERENCES recipient_profiles(id),
  name_snapshot TEXT NOT NULL,
  email_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, recipient_profile_id)
);
