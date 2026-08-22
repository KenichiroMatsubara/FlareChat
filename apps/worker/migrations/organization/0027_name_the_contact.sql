UPDATE `members` SET `description` = TRIM(
	CASE WHEN `description` = '' THEN '' ELSE `description` || ' / ' END
	|| (
		SELECT GROUP_CONCAT(`operational_task_roles`.`display_name`, ' / ')
		FROM `task_role_assignments`
		JOIN `operational_task_roles` ON `operational_task_roles`.`id` = `task_role_assignments`.`role_id`
		WHERE `task_role_assignments`.`member_id` = `members`.`id`
	)
)
WHERE EXISTS (SELECT 1 FROM `task_role_assignments` WHERE `task_role_assignments`.`member_id` = `members`.`id`);
--> statement-breakpoint
DROP INDEX `tasks_source_role_deadline_title_idx`;
--> statement-breakpoint
DELETE FROM `tasks` WHERE `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `tasks` GROUP BY `source_message_id`, `deadline`, `title`
);
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `assignee_role_id`;
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `assignee_role_name`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_deadline_title_idx` ON `tasks` (`source_message_id`,`deadline`,`title`);
--> statement-breakpoint
ALTER TABLE `rules` DROP COLUMN `task_role_ids`;
--> statement-breakpoint
ALTER TABLE `rule_revisions` DROP COLUMN `task_role_ids`;
--> statement-breakpoint
DROP TABLE `task_role_assignments`;
--> statement-breakpoint
DROP TABLE `task_role_revisions`;
--> statement-breakpoint
DROP TABLE `operational_task_roles`;
