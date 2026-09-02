-- Rows queued before the Member became a Contact (ADR 0157) carry `memberId`
-- rather than `contactId`, so the Contact is read from whichever the row has,
-- every key part is coalesced so the NOT NULL key can never be built from a
-- NULL, and a row whose new key is already taken is left under its old kind
-- rather than failing the whole release.
UPDATE OR IGNORE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'task', '$.contactId', COALESCE(json_extract(`payload`, '$.contactId'), json_extract(`payload`, '$.memberId'))),
	`idempotency_key` = 'reminder:task:' || COALESCE(json_extract(`payload`, '$.taskId'), '') || ':' || COALESCE(json_extract(`payload`, '$.contactId'), json_extract(`payload`, '$.memberId'), '') || ':' || COALESCE(json_extract(`payload`, '$.milestone'), '')
WHERE `kind` = 'task_reminder' AND json_valid(`payload`);
--> statement-breakpoint
UPDATE OR IGNORE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'registration', '$.contactId', COALESCE(json_extract(`payload`, '$.contactId'), json_extract(`payload`, '$.memberId'))),
	`idempotency_key` = 'reminder:registration:' || COALESCE(json_extract(`payload`, '$.eventId'), '') || ':' || COALESCE(json_extract(`payload`, '$.contactId'), json_extract(`payload`, '$.memberId'), '') || ':' || COALESCE(json_extract(`payload`, '$.milestone'), '')
WHERE `kind` = 'attendance_reminder' AND json_valid(`payload`);
--> statement-breakpoint
UPDATE OR IGNORE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'scheduled'),
	`idempotency_key` = 'reminder:scheduled:' || COALESCE(json_extract(`payload`, '$.contactId'), '') || ':' || `available_at` || ':' || COALESCE(json_extract(`payload`, '$.text'), '')
WHERE `kind` = 'mcp.reminder' AND json_valid(`payload`);
