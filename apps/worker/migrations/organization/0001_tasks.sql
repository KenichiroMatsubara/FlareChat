CREATE TABLE `task_role_assignments` (
	`role` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`display_name` text NOT NULL,
	`assigned_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_message_subject` text NOT NULL,
	`title` text NOT NULL,
	`deadline` text NOT NULL,
	`assignee_role` text NOT NULL,
	`assignee_identity_id` text,
	`assignee_name` text DEFAULT '未割り当て' NOT NULL,
	`description` text NOT NULL,
	`remarks` text DEFAULT '' NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_completed_check" CHECK("tasks"."completed" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_role_deadline_title_idx` ON `tasks` (`source_message_id`,`assignee_role`,`deadline`,`title`);
--> statement-breakpoint
CREATE INDEX `tasks_order_idx` ON `tasks` (`completed`,`deadline`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_identity_id`);
