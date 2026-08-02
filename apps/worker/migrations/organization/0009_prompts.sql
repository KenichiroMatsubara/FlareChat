CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_organization_name_idx` ON `prompts` (`organization_id`,`name`);
--> statement-breakpoint
CREATE TABLE `prompt_revisions` (
	`prompt_id` text NOT NULL,
	`revision` integer NOT NULL,
	`instructions` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`prompt_id`, `revision`),
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
