CREATE TABLE `agent_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`prompt_id` text NOT NULL,
	`selection_policy` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_rules_status_check" CHECK("agent_rules"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `agent_rules_status_idx` ON `agent_rules` (`status`);
--> statement-breakpoint
CREATE TABLE `agent_rule_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_rule_id` text NOT NULL,
	`revision` integer NOT NULL,
	`prompt_id` text NOT NULL,
	`selection_policy` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_rule_id`) REFERENCES `agent_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_rule_revisions_rule_revision_idx` ON `agent_rule_revisions` (`agent_rule_id`,`revision`);
