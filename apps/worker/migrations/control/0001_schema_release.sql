CREATE TABLE `schema_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`target_migration` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "schema_releases_id_check" CHECK("schema_releases"."id" = 'organization'),
	CONSTRAINT "schema_releases_state_check" CHECK("schema_releases"."state" in ('ready', 'migrating'))
);
--> statement-breakpoint
INSERT INTO `schema_releases` (`id`, `state`, `target_migration`, `updated_at`)
VALUES ('organization', 'ready', '', CURRENT_TIMESTAMP);
