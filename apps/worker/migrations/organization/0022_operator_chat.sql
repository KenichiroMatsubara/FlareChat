CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`token_envelope` text,
	`revision` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `mcp_servers_revision_check` CHECK (`revision` IS NULL OR `revision` in ('2026-07-28', '2025-06-18'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `rule_effects_carry` AS SELECT * FROM `rule_effects`;
--> statement-breakpoint
CREATE TABLE `rule_runs_next` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`agent_rule_id` text,
	`rule_revision` integer NOT NULL,
	`source_message_id` text,
	`execution_mode` text NOT NULL,
	`intent` text NOT NULL,
	`status` text NOT NULL,
	`planned_at` text,
	`expires_at` text,
	`decided_at` text,
	`decided_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON DELETE restrict,
	FOREIGN KEY (`agent_rule_id`) REFERENCES `agent_rules`(`id`) ON DELETE restrict,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON DELETE cascade,
	CONSTRAINT `rule_runs_owner_check` CHECK (
		(`intent` = 'chat' AND `rule_id` IS NULL AND `agent_rule_id` IS NULL AND `source_message_id` IS NULL)
		OR (`intent` != 'chat' AND (`rule_id` IS NULL) != (`agent_rule_id` IS NULL) AND `source_message_id` IS NOT NULL)
	),
	CONSTRAINT `rule_runs_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `rule_runs_intent_check` CHECK (`intent` in ('live', 'draft_preview', 'chat')),
	CONSTRAINT `rule_runs_status_check` CHECK (`status` in ('planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed'))
);
--> statement-breakpoint
INSERT INTO `rule_runs_next` SELECT
	`id`,`rule_id`,`agent_rule_id`,`rule_revision`,`source_message_id`,`execution_mode`,`intent`,`status`,
	`planned_at`,`expires_at`,`decided_at`,`decided_by`,`created_at`,`updated_at`
FROM `rule_runs`;
--> statement-breakpoint
DROP TABLE `rule_runs`;
--> statement-breakpoint
ALTER TABLE `rule_runs_next` RENAME TO `rule_runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_runs_live_schema_idx` ON `rule_runs` (`rule_id`,`rule_revision`,`source_message_id`) WHERE `intent` = 'live' AND `rule_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_runs_live_agent_idx` ON `rule_runs` (`agent_rule_id`,`rule_revision`,`source_message_id`) WHERE `intent` = 'live' AND `agent_rule_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `rule_runs_status_idx` ON `rule_runs` (`status`,`updated_at`);
--> statement-breakpoint
DELETE FROM `rule_effects`;
--> statement-breakpoint
INSERT INTO `rule_effects` (
	`id`,`rule_run_id`,`effect_key`,`kind`,`arguments`,`depends_on`,`idempotency_key`,`status`,`attempts`,
	`result`,`error`,`next_attempt_at`,`created_at`,`updated_at`
)
SELECT
	`id`,`rule_run_id`,`effect_key`,`kind`,`arguments`,`depends_on`,`idempotency_key`,`status`,`attempts`,
	`result`,`error`,`next_attempt_at`,`created_at`,`updated_at`
FROM `rule_effects_carry`;
--> statement-breakpoint
DROP TABLE `rule_effects_carry`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `chat_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_conversations_recent_idx` ON `chat_conversations` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `chat_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`rule_run_id` text NOT NULL,
	`position` integer NOT NULL,
	`request` text NOT NULL,
	`response` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON DELETE cascade,
	FOREIGN KEY (`rule_run_id`) REFERENCES `rule_runs`(`id`) ON DELETE cascade,
	CONSTRAINT `chat_turns_status_check` CHECK (`status` in ('running', 'completed', 'failed')),
	UNIQUE (`conversation_id`,`position`)
);
--> statement-breakpoint
CREATE INDEX `chat_turns_conversation_idx` ON `chat_turns` (`conversation_id`,`position`);
