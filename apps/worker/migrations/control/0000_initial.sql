CREATE TABLE `gemini_oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`pkce_verifier_envelope` text NOT NULL,
	`configuration_envelope` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gemini_oauth_states_state_hash_unique` ON `gemini_oauth_states` (`state_hash`);--> statement-breakpoint
CREATE TABLE `google_login_states` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`pkce_verifier_envelope` text NOT NULL,
	`return_origin` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_login_states_state_hash_unique` ON `google_login_states` (`state_hash`);--> statement-breakpoint
CREATE INDEX `google_login_states_expiry_idx` ON `google_login_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_email_unique` ON `identities` (`email`);--> statement-breakpoint
CREATE TABLE `members` (
	`organization_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `identity_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "members_role_check" CHECK("members"."role" in ('owner', 'admin', 'operator', 'viewer')),
	CONSTRAINT "members_state_check" CHECK("members"."state" in ('pending', 'active', 'suspended', 'removed'))
);
--> statement-breakpoint
CREATE INDEX `members_identity_idx` ON `members` (`identity_id`,`state`);--> statement-breakpoint
CREATE TABLE `organization_keys` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`master_key_version` text NOT NULL,
	`wrapped_key_envelope` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organization_setups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`oauth_state_hash` text NOT NULL,
	`pkce_verifier_envelope` text NOT NULL,
	`inbox_address` text,
	`google_subject` text,
	`granted_scopes` text,
	`credential_envelope` text,
	`history_id` text,
	`owner_identity_id` text,
	`organization_id` text,
	`database_id` text,
	`binding_name` text,
	`provisioning_key` text,
	`provisioning_phase` text,
	`error_message` text,
	`expires_at` text NOT NULL,
	`provisioning_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "organization_setups_state_check" CHECK("organization_setups"."state" in ('awaiting_google', 'awaiting_name', 'provisioning', 'active', 'expired', 'failed')),
	CONSTRAINT "organization_setups_provisioning_phase_check" CHECK("organization_setups"."provisioning_phase" is null or "organization_setups"."provisioning_phase" in ('allocating_database', 'applying_schema', 'storing_credentials', 'verifying_binding', 'activating_organization'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_setups_inbox_address_unique` ON `organization_setups` (`inbox_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_setups_organization_id_unique` ON `organization_setups` (`organization_id`);--> statement-breakpoint
CREATE INDEX `setups_state_expiry_idx` ON `organization_setups` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`database_id` text,
	`binding_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK("organizations"."status" in ('provisioning', 'active', 'suspended', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `organizations_status_idx` ON `organizations` (`status`);--> statement-breakpoint
CREATE TABLE `recovery_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`requested_by_identity_id` text NOT NULL,
	`executed_by_identity_id` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`executed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executed_by_identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_requests_state_check" CHECK("recovery_requests"."state" in ('requested', 'executing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_requests_organization_idempotency_idx` ON `recovery_requests` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `recovery_requests_org_state_idx` ON `recovery_requests` (`organization_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`,`revoked_at`);