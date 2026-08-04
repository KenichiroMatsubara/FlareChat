ALTER TABLE `members` ADD `google_subject` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `members_google_subject_unique` ON `members` (`google_subject`) WHERE `google_subject` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `attendance` RENAME TO `attendance_legacy`;
--> statement-breakpoint
CREATE TABLE `attendance` (
	`event_id` text NOT NULL,
	`member_id` text NOT NULL,
	`status` text DEFAULT 'unanswered' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `member_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attendance_status_check" CHECK("attendance"."status" in ('unanswered', 'attending', 'not_attending'))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `attendance` (`event_id`, `member_id`, `status`, `comment`, `updated_at`)
SELECT `attendance_legacy`.`event_id`, `members`.`id`, `attendance_legacy`.`status`, `attendance_legacy`.`comment`, `attendance_legacy`.`updated_at`
FROM `attendance_legacy`
JOIN `list_items` ON `list_items`.`id` = `attendance_legacy`.`recipient_item_id`
JOIN `members` ON `members`.`email` = `list_items`.`value` AND `members`.`email` <> ''
WHERE `attendance_legacy`.`revoked_at` IS NULL;
--> statement-breakpoint
DROP TABLE `attendance_legacy`;
--> statement-breakpoint
CREATE TABLE `portal_invitations` (
	`token` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portal_invitations_member_idx` ON `portal_invitations` (`member_id`,`used_at`);
