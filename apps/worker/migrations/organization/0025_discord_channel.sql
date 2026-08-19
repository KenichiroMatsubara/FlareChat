PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `line_destinations_carry` AS SELECT * FROM `line_destinations`;
--> statement-breakpoint
CREATE TABLE `member_line_destinations_carry` AS SELECT * FROM `member_line_destinations`;
--> statement-breakpoint
CREATE TABLE `connections_next` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`credential` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `connections_kind_check` CHECK (`kind` in ('line', 'ai', 'discord')),
	CONSTRAINT `connections_status_check` CHECK (`status` in ('active', 'disconnected'))
);
--> statement-breakpoint
INSERT INTO `connections_next` SELECT `id`,`kind`,`label`,`credential`,`status`,`created_at`,`updated_at` FROM `connections`;
--> statement-breakpoint
DROP TABLE `connections`;
--> statement-breakpoint
ALTER TABLE `connections_next` RENAME TO `connections`;
--> statement-breakpoint
DELETE FROM `line_destinations`;
--> statement-breakpoint
INSERT INTO `line_destinations` (
	`id`,`connection_id`,`destination_id`,`display_name`,`kind`,`status`,`source`,`discovered_at`,`updated_at`
)
SELECT `id`,`connection_id`,`destination_id`,`display_name`,`kind`,`status`,`source`,`discovered_at`,`updated_at`
FROM `line_destinations_carry`;
--> statement-breakpoint
DROP TABLE `line_destinations_carry`;
--> statement-breakpoint
DELETE FROM `member_line_destinations`;
--> statement-breakpoint
INSERT INTO `member_line_destinations` (`member_id`,`line_destination_id`,`created_at`)
SELECT `member_id`,`line_destination_id`,`created_at` FROM `member_line_destinations_carry`;
--> statement-breakpoint
DROP TABLE `member_line_destinations_carry`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `channel_handles` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`channel` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_id` text NOT NULL,
	`reply_target` text,
	`kind` text DEFAULT 'single' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'inbound' NOT NULL,
	`is_primary` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `members`(`id`) ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON DELETE cascade,
	CONSTRAINT `channel_handles_channel_check` CHECK (`channel` in ('discord')),
	CONSTRAINT `channel_handles_kind_check` CHECK (`kind` in ('single', 'shared')),
	CONSTRAINT `channel_handles_source_check` CHECK (`source` in ('inbound', 'manual')),
	CONSTRAINT `channel_handles_primary_check` CHECK (`is_primary` in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_handles_identity_idx` ON `channel_handles` (`channel`,`connection_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `channel_handles_contact_idx` ON `channel_handles` (`contact_id`,`channel`);
