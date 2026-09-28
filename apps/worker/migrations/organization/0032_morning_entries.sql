CREATE TABLE `morning_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`contact_id` text,
	`source_message_id` text REFERENCES `source_messages`(`id`),
	`heading` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`idempotency_key` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	CONSTRAINT "morning_entries_channel_check" CHECK("morning_entries"."channel" in ('email', 'line', 'discord')),
	CONSTRAINT "morning_entries_state_check" CHECK("morning_entries"."state" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `morning_entries_idempotency_key_unique` ON `morning_entries` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `morning_entries_state_idx` ON `morning_entries` (`state`,`attempts`,`created_at`);
