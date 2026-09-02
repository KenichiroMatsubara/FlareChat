UPDATE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'task'),
	`idempotency_key` = 'reminder:task:' || json_extract(`payload`, '$.taskId') || ':' || json_extract(`payload`, '$.contactId') || ':' || json_extract(`payload`, '$.milestone')
WHERE `kind` = 'task_reminder';
--> statement-breakpoint
UPDATE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'registration'),
	`idempotency_key` = 'reminder:registration:' || json_extract(`payload`, '$.eventId') || ':' || json_extract(`payload`, '$.contactId') || ':' || json_extract(`payload`, '$.milestone')
WHERE `kind` = 'attendance_reminder';
--> statement-breakpoint
UPDATE `jobs` SET
	`kind` = 'reminder',
	`payload` = json_set(`payload`, '$.subject', 'scheduled'),
	`idempotency_key` = 'reminder:scheduled:' || json_extract(`payload`, '$.contactId') || ':' || `available_at` || ':' || json_extract(`payload`, '$.text')
WHERE `kind` = 'mcp.reminder';
