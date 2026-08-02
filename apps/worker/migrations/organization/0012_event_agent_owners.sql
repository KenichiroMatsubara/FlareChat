ALTER TABLE `events` ADD `agent_rule_id` text REFERENCES agent_rules(id);
--> statement-breakpoint
INSERT OR IGNORE INTO `rules` (`id`, `organization_id`, `name`, `status`, `created_at`, `updated_at`)
SELECT 'legacy-owning-rule-' || `organization_id`, `organization_id`, 'Migrated Owning Rule', 'archived', MIN(`created_at`), MAX(`updated_at`)
FROM `events`
WHERE `rule_id` IS NULL
GROUP BY `organization_id`;
--> statement-breakpoint
UPDATE `events`
SET `rule_id` = 'legacy-owning-rule-' || `organization_id`
WHERE `rule_id` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `events_owning_rule_insert_check`
BEFORE INSERT ON `events`
WHEN (NEW.`rule_id` IS NULL) = (NEW.`agent_rule_id` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'Scheduled Event requires exactly one Owning Rule');
END;
--> statement-breakpoint
CREATE TRIGGER `events_owning_rule_update_check`
BEFORE UPDATE OF `rule_id`, `agent_rule_id` ON `events`
WHEN (NEW.`rule_id` IS NULL) = (NEW.`agent_rule_id` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'Scheduled Event requires exactly one Owning Rule');
END;
