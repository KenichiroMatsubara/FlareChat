CREATE TABLE `rule_permitted_recipient_lists` (
	`rule_id` text NOT NULL,
	`list_id` text NOT NULL,
	PRIMARY KEY(`rule_id`, `list_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT OR IGNORE INTO `rule_permitted_recipient_lists` (`rule_id`, `list_id`)
SELECT `id`, `recipient_list_id` FROM `rules` WHERE `recipient_list_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `rule_permitted_line_lists` (
	`rule_id` text NOT NULL,
	`list_id` text NOT NULL,
	PRIMARY KEY(`rule_id`, `list_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT OR IGNORE INTO `rule_permitted_line_lists` (`rule_id`, `list_id`)
SELECT `id`, `line_list_id` FROM `rules` WHERE `line_list_id` IS NOT NULL;
