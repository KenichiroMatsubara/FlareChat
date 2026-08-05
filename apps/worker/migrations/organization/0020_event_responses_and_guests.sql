ALTER TABLE `events` ADD `calendar_etag` text;--> statement-breakpoint
ALTER TABLE `events` ADD `calendar_description` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `guest_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`name` text NOT NULL,
	`affiliation` text DEFAULT '' NOT NULL,
	`attending` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `guest_registrations_event_idx` ON `guest_registrations` (`event_id`);--> statement-breakpoint
CREATE INDEX `guest_registrations_source_idx` ON `guest_registrations` (`event_id`,`source_message_id`);
