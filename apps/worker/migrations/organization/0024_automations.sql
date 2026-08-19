CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt_id` text NOT NULL,
	`contact_list_id` text,
	`schedule` text NOT NULL,
	`offset_minutes` integer DEFAULT 0 NOT NULL,
	`execution_mode` text DEFAULT 'unattended' NOT NULL,
	`suppression_window` text DEFAULT 'day' NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON DELETE restrict,
	FOREIGN KEY (`contact_list_id`) REFERENCES `contact_lists`(`id`) ON DELETE restrict,
	CONSTRAINT `automations_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `automations_state_check` CHECK (`state` in ('draft', 'active', 'suspended', 'archived')),
	CONSTRAINT `automations_window_check` CHECK (`suppression_window` in ('none', 'hour', 'day', 'week', 'forever')),
	CONSTRAINT `automations_offset_check` CHECK (`offset_minutes` between -840 and 840)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_name_idx` ON `automations` (`name`);
--> statement-breakpoint
CREATE INDEX `automations_due_idx` ON `automations` (`state`,`next_run_at`);
--> statement-breakpoint
CREATE TABLE `automation_tools` (
	`automation_id` text NOT NULL,
	`tool` text NOT NULL,
	PRIMARY KEY (`automation_id`, `tool`),
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`rule_run_id` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade,
	FOREIGN KEY (`rule_run_id`) REFERENCES `rule_runs`(`id`) ON DELETE cascade,
	CONSTRAINT `automation_runs_status_check` CHECK (`status` in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `automation_runs_recent_idx` ON `automation_runs` (`automation_id`,`started_at`);
