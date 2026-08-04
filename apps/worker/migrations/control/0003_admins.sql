ALTER TABLE `members` RENAME TO `members_legacy`;
--> statement-breakpoint
DROP INDEX IF EXISTS `members_identity_idx`;
--> statement-breakpoint
CREATE TABLE `admins` (
	`organization_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `identity_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "admins_role_check" CHECK("admins"."role" in ('owner', 'admin', 'operator', 'viewer')),
	CONSTRAINT "admins_state_check" CHECK("admins"."state" in ('pending', 'active', 'suspended', 'removed'))
);
--> statement-breakpoint
INSERT INTO `admins` (`organization_id`, `identity_id`, `role`, `state`, `created_at`, `updated_at`)
SELECT `organization_id`, `identity_id`, `role`, `state`, `created_at`, `updated_at`
FROM `members_legacy`;
--> statement-breakpoint
DROP TABLE `members_legacy`;
--> statement-breakpoint
CREATE INDEX `admins_identity_idx` ON `admins` (`identity_id`,`state`);
