ALTER TABLE `rules` ADD `execution_mode` text DEFAULT 'unattended' NOT NULL
CHECK (`execution_mode` in ('read_only', 'approval', 'unattended'));
--> statement-breakpoint
ALTER TABLE `rule_revisions` ADD `execution_mode` text DEFAULT 'unattended' NOT NULL
CHECK (`execution_mode` in ('read_only', 'approval', 'unattended'));
--> statement-breakpoint
ALTER TABLE `rules` ADD `current_revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `rules`
SET `current_revision` = COALESCE((
	SELECT MAX(`rule_revisions`.`revision`)
	FROM `rule_revisions`
	WHERE `rule_revisions`.`rule_id` = `rules`.`id`
), 1);
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `agent_rules_next` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`execution_mode` text DEFAULT 'unattended' NOT NULL,
	`prompt_id` text NOT NULL,
	`selection_policy` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON DELETE restrict,
	CONSTRAINT `agent_rules_status_check` CHECK (`status` in ('draft', 'active', 'suspended', 'archived')),
	CONSTRAINT `agent_rules_execution_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended'))
);
--> statement-breakpoint
INSERT INTO `agent_rules_next` SELECT `id`,`organization_id`,`name`,`status`,`execution_mode`,`prompt_id`,`selection_policy`,`priority`,`current_revision`,`created_at`,`updated_at` FROM `agent_rules`;
--> statement-breakpoint
DROP TABLE `agent_rules`;
--> statement-breakpoint
ALTER TABLE `agent_rules_next` RENAME TO `agent_rules`;
--> statement-breakpoint
CREATE INDEX `agent_rules_status_idx` ON `agent_rules` (`status`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `rule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`agent_rule_id` text,
	`rule_revision` integer NOT NULL,
	`source_message_id` text NOT NULL,
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
	CONSTRAINT `rule_runs_owner_check` CHECK ((`rule_id` IS NULL) != (`agent_rule_id` IS NULL)),
	CONSTRAINT `rule_runs_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `rule_runs_intent_check` CHECK (`intent` in ('live', 'draft_preview')),
	CONSTRAINT `rule_runs_status_check` CHECK (`status` in ('planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_runs_live_schema_idx` ON `rule_runs` (`rule_id`,`rule_revision`,`source_message_id`) WHERE `intent` = 'live' AND `rule_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_runs_live_agent_idx` ON `rule_runs` (`agent_rule_id`,`rule_revision`,`source_message_id`) WHERE `intent` = 'live' AND `agent_rule_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `rule_runs_status_idx` ON `rule_runs` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `rule_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_run_id` text NOT NULL,
	`effect_key` text NOT NULL,
	`kind` text NOT NULL,
	`arguments` text NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`rule_run_id`) REFERENCES `rule_runs`(`id`) ON DELETE cascade,
	CONSTRAINT `rule_effects_status_check` CHECK (`status` in ('planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired')),
	CONSTRAINT `rule_effects_attempts_check` CHECK (`attempts` >= 0),
	UNIQUE (`rule_run_id`,`effect_key`),
	UNIQUE (`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `rule_effects_run_idx` ON `rule_effects` (`rule_run_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `rule_effects_retry_idx` ON `rule_effects` (`status`,`next_attempt_at`);
--> statement-breakpoint
INSERT INTO `rule_runs` (
	`id`,`rule_id`,`agent_rule_id`,`rule_revision`,`source_message_id`,`execution_mode`,`intent`,`status`,
	`planned_at`,`expires_at`,`decided_at`,`decided_by`,`created_at`,`updated_at`
)
SELECT
	`proposed_actions`.`agent_run_id`,
	NULL,
	`agent_runs`.`agent_rule_id`,
	`agent_runs`.`agent_rule_revision`,
	`agent_runs`.`source_message_id`,
	'approval',
	'live',
	CASE
		WHEN SUM(CASE WHEN `proposed_actions`.`status` = 'pending' THEN 1 ELSE 0 END) > 0 THEN 'pending_approval'
		WHEN SUM(CASE WHEN `proposed_actions`.`status` = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
		WHEN SUM(CASE WHEN `proposed_actions`.`status` = 'expired' THEN 1 ELSE 0 END) > 0 THEN 'expired'
		WHEN SUM(CASE WHEN `proposed_actions`.`status` = 'rejected' THEN 1 ELSE 0 END) > 0 THEN 'rejected'
		ELSE 'completed'
	END,
	MIN(`proposed_actions`.`created_at`),
	MAX(`proposed_actions`.`expires_at`),
	MAX(`proposed_actions`.`decided_at`),
	MAX(`proposed_actions`.`decided_by`),
	MIN(`proposed_actions`.`created_at`),
	COALESCE(MAX(`proposed_actions`.`decided_at`), MAX(`proposed_actions`.`created_at`))
FROM `proposed_actions`
INNER JOIN `agent_runs` ON `agent_runs`.`id` = `proposed_actions`.`agent_run_id`
GROUP BY `proposed_actions`.`agent_run_id`;
--> statement-breakpoint
INSERT INTO `rule_effects` (
	`id`,`rule_run_id`,`effect_key`,`kind`,`arguments`,`depends_on`,`idempotency_key`,`status`,`attempts`,
	`result`,`error`,`next_attempt_at`,`created_at`,`updated_at`
)
SELECT
	`proposed_actions`.`id`,
	`proposed_actions`.`agent_run_id`,
	`proposed_actions`.`id`,
	'agent.' || `proposed_actions`.`tool`,
	`proposed_actions`.`arguments`,
	'[]',
	'legacy:' || `proposed_actions`.`id`,
	CASE `proposed_actions`.`status`
		WHEN 'approved' THEN 'succeeded'
		WHEN 'failed' THEN 'permanent_failed'
		ELSE `proposed_actions`.`status`
	END,
	CASE WHEN `proposed_actions`.`status` IN ('approved', 'failed') THEN 1 ELSE 0 END,
	NULL,
	CASE WHEN `proposed_actions`.`status` = 'failed' THEN 'Legacy Proposed Action failed.' ELSE NULL END,
	NULL,
	`proposed_actions`.`created_at`,
	COALESCE(`proposed_actions`.`decided_at`, `proposed_actions`.`created_at`)
FROM `proposed_actions`
INNER JOIN `agent_runs` ON `agent_runs`.`id` = `proposed_actions`.`agent_run_id`;
