CREATE TABLE `contact_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_lists_name_idx` ON `contact_lists` (`name`);
--> statement-breakpoint
CREATE TABLE `contact_list_members` (
	`list_id` text NOT NULL,
	`contact_id` text NOT NULL,
	PRIMARY KEY (`list_id`, `contact_id`),
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `members`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`contact_list_id` text NOT NULL,
	`suppression_window` text DEFAULT 'day' NOT NULL,
	`calls_per_hour` integer DEFAULT 60 NOT NULL,
	`writes_per_day` integer DEFAULT 100 NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_list_id`) REFERENCES `contact_lists`(`id`) ON DELETE restrict,
	CONSTRAINT `access_tokens_window_check` CHECK (`suppression_window` in ('none', 'hour', 'day', 'week', 'forever')),
	CONSTRAINT `access_tokens_calls_check` CHECK (`calls_per_hour` > 0),
	CONSTRAINT `access_tokens_writes_check` CHECK (`writes_per_day` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_hash_idx` ON `access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `access_token_tools` (
	`token_id` text NOT NULL,
	`tool` text NOT NULL,
	PRIMARY KEY (`token_id`, `tool`),
	FOREIGN KEY (`token_id`) REFERENCES `access_tokens`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_token_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`tool` text NOT NULL,
	`is_write` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `access_tokens`(`id`) ON DELETE cascade,
	CONSTRAINT `access_token_calls_write_check` CHECK (`is_write` in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `access_token_calls_window_idx` ON `access_token_calls` (`token_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `suppressions` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tool` text NOT NULL,
	`recorded_at` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `suppressions_expiry_idx` ON `suppressions` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `prompts` ADD `published` integer DEFAULT 0 NOT NULL;
