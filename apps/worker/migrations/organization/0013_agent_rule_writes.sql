ALTER TABLE `agent_rules` ADD `execution_mode` text DEFAULT 'read_only' NOT NULL
CHECK (`execution_mode` in ('read_only', 'approval', 'unattended'));
--> statement-breakpoint
ALTER TABLE `agent_rule_revisions` ADD `execution_mode` text DEFAULT 'read_only' NOT NULL
CHECK (`execution_mode` in ('read_only', 'approval', 'unattended'));
--> statement-breakpoint
ALTER TABLE `agent_rule_revisions` ADD `permitted_recipient_list_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_rule_revisions` ADD `permitted_line_list_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TABLE `proposed_actions` (
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
	CONSTRAINT "proposed_actions_tool_check" CHECK("proposed_actions"."tool" in ('send_line_message', 'create_scheduled_event')),
	CONSTRAINT "proposed_actions_status_check" CHECK("proposed_actions"."status" in ('pending', 'approved', 'rejected', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `proposed_actions_run_idx` ON `proposed_actions` (`agent_run_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_rule_permitted_recipient_lists` (
	`agent_rule_id` text NOT NULL,
	`list_id` text NOT NULL,
	PRIMARY KEY(`agent_rule_id`, `list_id`),
	FOREIGN KEY (`agent_rule_id`) REFERENCES `agent_rules`(`id`) ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_rule_permitted_line_lists` (
	`agent_rule_id` text NOT NULL,
	`list_id` text NOT NULL,
	PRIMARY KEY(`agent_rule_id`, `list_id`),
	FOREIGN KEY (`agent_rule_id`) REFERENCES `agent_rules`(`id`) ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`)
);
