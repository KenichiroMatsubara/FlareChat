CREATE TABLE `task_role_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`reviewed_revision` integer DEFAULT 0 NOT NULL,
	`changed_at` text NOT NULL,
	`reviewed_at` text
);
