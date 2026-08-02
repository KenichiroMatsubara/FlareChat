CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_rule_id` text NOT NULL,
	`agent_rule_revision` integer NOT NULL,
	`prompt_id` text NOT NULL,
	`prompt_revision` integer NOT NULL,
	`source_message_id` text NOT NULL,
	`model` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`outcome` text NOT NULL,
	`tool_call_count` integer NOT NULL,
	`tokens` integer NOT NULL,
	`transcript_key` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`agent_rule_id`) REFERENCES `agent_rules`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_runs_outcome_check" CHECK("agent_runs"."outcome" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_rule_source_idx` ON `agent_runs` (`agent_rule_id`,`source_message_id`);
--> statement-breakpoint
CREATE INDEX `agent_runs_started_idx` ON `agent_runs` (`started_at`);
