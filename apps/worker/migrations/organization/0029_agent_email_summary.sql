CREATE TABLE `proposed_actions_new` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`agent_rule_id` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	CONSTRAINT "proposed_actions_tool_check" CHECK("proposed_actions_new"."tool" in ('send_line_message', 'create_scheduled_event', 'send_email_summary')),
	CONSTRAINT "proposed_actions_status_check" CHECK("proposed_actions_new"."status" in ('pending', 'approved', 'rejected', 'expired', 'failed'))
);
--> statement-breakpoint
INSERT INTO `proposed_actions_new` SELECT `id`, `agent_run_id`, `agent_rule_id`, `tool`, `arguments`, `status`, `created_at`, `expires_at`, `decided_at`, `decided_by` FROM `proposed_actions`;
--> statement-breakpoint
DROP TABLE `proposed_actions`;
--> statement-breakpoint
ALTER TABLE `proposed_actions_new` RENAME TO `proposed_actions`;
--> statement-breakpoint
CREATE INDEX `proposed_actions_run_idx` ON `proposed_actions` (`agent_run_id`,`created_at`);
