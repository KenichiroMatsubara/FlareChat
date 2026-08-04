ALTER TABLE `task_role_assignments` RENAME TO `task_role_assignments_legacy`;
--> statement-breakpoint
CREATE TABLE `task_role_assignments` (
	`role_id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`display_name` text NOT NULL,
	`assigned_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `operational_task_roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `task_role_assignments_legacy`;
--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_assignee_idx`;
--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `assignee_identity_id` TO `assignee_member_id`;
--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_member_id`);
