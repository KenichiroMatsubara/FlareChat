ALTER TABLE `deliveries` ADD `source_message_id` text REFERENCES `source_messages`(`id`);
--> statement-breakpoint
CREATE INDEX `deliveries_source_message_idx` ON `deliveries` (`source_message_id`,`created_at`);
