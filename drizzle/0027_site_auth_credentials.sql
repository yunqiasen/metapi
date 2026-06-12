CREATE TABLE `site_auth_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`subject` text,
	`email` text,
	`username` text,
	`credential_type` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`last_verified_at` text,
	`last_error` text,
	`proxy_url` text,
	`use_system_proxy` integer DEFAULT false,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `site_auth_credentials_provider_idx` ON `site_auth_credentials` (`provider`);--> statement-breakpoint
CREATE INDEX `site_auth_credentials_status_idx` ON `site_auth_credentials` (`status`);--> statement-breakpoint
CREATE INDEX `site_auth_credentials_provider_subject_idx` ON `site_auth_credentials` (`provider`,`subject`);
