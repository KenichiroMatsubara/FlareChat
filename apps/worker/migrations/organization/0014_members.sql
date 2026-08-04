ALTER TABLE `event_recipients` RENAME TO `event_recipients_legacy`;
--> statement-breakpoint
ALTER TABLE `recipient_link_tokens` RENAME TO `recipient_link_tokens_legacy`;
--> statement-breakpoint
ALTER TABLE `recipient_line_destinations` RENAME TO `recipient_line_destinations_legacy`;
--> statement-breakpoint
ALTER TABLE `recipient_profiles` RENAME TO `recipient_profiles_legacy`;
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "members_state_check" CHECK("members"."state" in ('active', 'inactive'))
);
--> statement-breakpoint
INSERT INTO `members` (`id`, `organization_id`, `name`, `email`, `state`, `tags`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `name`, `email`, `state`, `tags`, `created_at`, `updated_at`
FROM `recipient_profiles_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_unique` ON `members` (`email`) WHERE `email` <> '';
--> statement-breakpoint
CREATE TABLE `event_recipients` (
	`event_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`email_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `member_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `event_recipients` (`event_id`, `member_id`, `name_snapshot`, `email_snapshot`, `created_at`)
SELECT `event_id`, `recipient_profile_id`, `name_snapshot`, `email_snapshot`, `created_at`
FROM `event_recipients_legacy`;
--> statement-breakpoint
CREATE TABLE `member_link_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `member_link_tokens` (`token`, `member_id`, `expires_at`, `used_at`, `created_at`)
SELECT `token`, `recipient_profile_id`, `expires_at`, `used_at`, `created_at`
FROM `recipient_link_tokens_legacy`;
--> statement-breakpoint
CREATE TABLE `member_line_destinations` (
	`member_id` text NOT NULL,
	`line_destination_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `line_destination_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`line_destination_id`) REFERENCES `line_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `member_line_destinations` (`member_id`, `line_destination_id`, `created_at`)
SELECT `recipient_profile_id`, `line_destination_id`, `created_at`
FROM `recipient_line_destinations_legacy`;
--> statement-breakpoint
DROP TABLE `event_recipients_legacy`;
--> statement-breakpoint
DROP TABLE `recipient_link_tokens_legacy`;
--> statement-breakpoint
DROP TABLE `recipient_line_destinations_legacy`;
--> statement-breakpoint
DROP TABLE `recipient_profiles_legacy`;
--> statement-breakpoint
DELETE FROM `task_role_assignments`;
--> statement-breakpoint
UPDATE `tasks` SET `assignee_identity_id` = NULL, `assignee_name` = '未割り当て';
