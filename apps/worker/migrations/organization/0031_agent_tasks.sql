ALTER TABLE `tasks` ADD `scheduled_event_id` text REFERENCES `events`(`id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduled_event_title` text;
--> statement-breakpoint
CREATE INDEX `tasks_scheduled_event_idx` ON `tasks` (`scheduled_event_id`);
