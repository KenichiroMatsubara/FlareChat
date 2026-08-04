CREATE TABLE `member_logins` (
	`google_subject` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_logins_organization_idx` ON `member_logins` (`organization_id`);
