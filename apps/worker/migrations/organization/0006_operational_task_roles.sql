ALTER TABLE `task_role_assignments` RENAME TO `task_role_assignments_legacy`;
--> statement-breakpoint
ALTER TABLE `tasks` RENAME TO `tasks_legacy`;
--> statement-breakpoint
CREATE TABLE `operational_task_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `operational_task_roles` (`id`, `display_name`, `description`, `created_at`, `updated_at`)
SELECT `role`, `role`, 'Migrated Operational Task Role', MIN(`assigned_at`), MAX(`updated_at`)
FROM `task_role_assignments_legacy`
GROUP BY `role`;
--> statement-breakpoint
INSERT OR IGNORE INTO `operational_task_roles` (`id`, `display_name`, `description`, `created_at`, `updated_at`)
SELECT `assignee_role`, `assignee_role`, 'Migrated Operational Task Role', MIN(`created_at`), MAX(`updated_at`)
FROM `tasks_legacy`
GROUP BY `assignee_role`;
--> statement-breakpoint
CREATE TABLE `task_role_assignments` (
	`role_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`display_name` text NOT NULL,
	`assigned_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `operational_task_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `task_role_assignments` (`role_id`, `identity_id`, `display_name`, `assigned_at`, `updated_at`)
SELECT `role`, `identity_id`, `display_name`, `assigned_at`, `updated_at`
FROM `task_role_assignments_legacy`;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_message_subject` text NOT NULL,
	`title` text NOT NULL,
	`deadline` text NOT NULL,
	`assignee_role_id` text NOT NULL,
	`assignee_role_name` text NOT NULL,
	`assignee_identity_id` text,
	`assignee_name` text DEFAULT '未割り当て' NOT NULL,
	`description` text NOT NULL,
	`remarks` text DEFAULT '' NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `tasks_completed_check` CHECK(`tasks`.`completed` in (0, 1))
);
--> statement-breakpoint
INSERT INTO `tasks` (`id`, `organization_id`, `source_message_id`, `source_message_subject`, `title`, `deadline`, `assignee_role_id`, `assignee_role_name`, `assignee_identity_id`, `assignee_name`, `description`, `remarks`, `completed`, `completed_at`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `source_message_id`, `source_message_subject`, `title`, `deadline`, `assignee_role`, `assignee_role`, `assignee_identity_id`, `assignee_name`, `description`, `remarks`, `completed`, `completed_at`, `created_at`, `updated_at`
FROM `tasks_legacy`;
--> statement-breakpoint
DROP TABLE `task_role_assignments_legacy`;
--> statement-breakpoint
DROP TABLE `tasks_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_role_deadline_title_idx` ON `tasks` (`source_message_id`,`assignee_role_id`,`deadline`,`title`);
--> statement-breakpoint
CREATE INDEX `tasks_order_idx` ON `tasks` (`completed`,`deadline`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_identity_id`);
--> statement-breakpoint
ALTER TABLE `rules` ADD `task_role_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE `rules` SET `task_role_ids` = COALESCE((SELECT json_group_array(`id`) FROM `operational_task_roles`), '[]');
--> statement-breakpoint
ALTER TABLE `rule_revisions` ADD `task_role_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE `rule_revisions` SET `task_role_ids` = COALESCE((SELECT json_group_array(`id`) FROM `operational_task_roles`), '[]');
--> statement-breakpoint
CREATE TABLE `automation_warnings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_message_id` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automation_warnings_source_idx` ON `automation_warnings` (`source_message_id`,`created_at`);
