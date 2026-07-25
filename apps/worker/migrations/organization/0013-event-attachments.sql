CREATE TABLE IF NOT EXISTS event_attachments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  gmail_attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  drive_file_id TEXT,
  public_url TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  created_at TEXT NOT NULL,
  UNIQUE(event_id, gmail_attachment_id)
);

CREATE INDEX IF NOT EXISTS event_attachments_event_idx ON event_attachments(event_id, created_at);
