CREATE TABLE `attendance` (
	`event_id` text NOT NULL,
	`recipient_item_id` text NOT NULL,
	`status` text DEFAULT 'unanswered' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`token` text NOT NULL,
	`revoked_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `recipient_item_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_item_id`) REFERENCES `list_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_token_unique` ON `attendance` (`token`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`credential` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`outcome` text NOT NULL,
	`external_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `delivery_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`record_count` integer NOT NULL,
	`archived_before` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`gmail_attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`drive_file_id` text,
	`public_url` text,
	`outcome` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_attachments_event_gmail_idx` ON `event_attachments` (`event_id`,`gmail_attachment_id`);--> statement-breakpoint
CREATE INDEX `event_attachments_event_idx` ON `event_attachments` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `event_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`actor_identity_id` text NOT NULL,
	`changes_json` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_overrides_event_idx` ON `event_overrides` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `event_recipients` (
	`event_id` text NOT NULL,
	`recipient_profile_id` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`email_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `recipient_profile_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_profile_id`) REFERENCES `recipient_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`rule_id` text,
	`source_message_id` text,
	`google_event_id` text,
	`title` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`attendance_deadline` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`starts_at`);--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_message_id` text,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exceptions_state_idx` ON `exceptions` (`state`);--> statement-breakpoint
CREATE TABLE `google_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`google_subject` text NOT NULL,
	`inbox_address` text NOT NULL,
	`granted_scopes` text NOT NULL,
	`token_envelope` text NOT NULL,
	`gmail_history_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_connections_google_subject_unique` ON `google_connections` (`google_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `google_connections_inbox_address_unique` ON `google_connections` (`inbox_address`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`state`,`available_at`);--> statement-breakpoint
CREATE TABLE `line_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `line_destinations_connection_destination_idx` ON `line_destinations` (`connection_id`,`destination_id`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`value` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_items_list_value_idx` ON `list_items` (`list_id`,`value`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lists_kind_idx` ON `lists` (`kind`);--> statement-breakpoint
CREATE TABLE `recipient_line_destinations` (
	`recipient_profile_id` text NOT NULL,
	`line_destination_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`recipient_profile_id`, `line_destination_id`),
	FOREIGN KEY (`recipient_profile_id`) REFERENCES `recipient_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`line_destination_id`) REFERENCES `line_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipient_link_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`recipient_profile_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recipient_profile_id`) REFERENCES `recipient_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipient_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipient_profiles_email_unique` ON `recipient_profiles` (`email`);--> statement-breakpoint
CREATE TABLE `rule_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`revision` integer NOT NULL,
	`selection_policy` text NOT NULL,
	`routing_policy` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_revisions_rule_revision_idx` ON `rule_revisions` (`rule_id`,`revision`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`source_list_id` text,
	`recipient_list_id` text,
	`line_list_id` text,
	`selection_policy` text DEFAULT '{}' NOT NULL,
	`routing_policy` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`schedule_minutes` integer DEFAULT 5 NOT NULL,
	`require_attendance` integer DEFAULT false NOT NULL,
	`deadline_days_before` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`line_list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rules_status_idx` ON `rules` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`gmail_message_id` text NOT NULL,
	`gmail_history_id` text NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text,
	`state` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_messages_gmail_message_id_unique` ON `source_messages` (`gmail_message_id`);