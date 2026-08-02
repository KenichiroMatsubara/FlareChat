DROP INDEX `recipient_profiles_email_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `recipient_profiles_email_unique` ON `recipient_profiles` (`email`) WHERE `email` <> '';
