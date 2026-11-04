CREATE TABLE `contact_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`kind` text NOT NULL,
	`value_normalized` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`raw` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_identities_uq` ON `contact_identities` (`org_id`,`kind`,`scope`,`value_normalized`);--> statement-breakpoint
CREATE INDEX `contact_identities_contact_idx` ON `contact_identities` (`org_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `contact_identities_value_idx` ON `contact_identities` (`org_id`,`value_normalized`);--> statement-breakpoint
CREATE TABLE `custom_channels` (
	`org_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`url_pattern` text,
	`prefix` text,
	`followup_days` integer,
	`stale_days` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'email', `email`, '', `email`, `created_at` FROM `contacts` WHERE `email` IS NOT NULL AND `email` != '';
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'linkedin_url', `linkedin`, '', `linkedin`, `created_at` FROM `contacts` WHERE `linkedin` IS NOT NULL AND `linkedin` != '';
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'x_handle', `x`, '', `x`, `created_at` FROM `contacts` WHERE `x` IS NOT NULL AND `x` != '';
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'reddit_user', `reddit_user`, '', `reddit_user`, `created_at` FROM `contacts` WHERE `reddit_user` IS NOT NULL AND `reddit_user` != '';
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'github', `github`, '', `github`, `created_at` FROM `contacts` WHERE `github` IS NOT NULL AND `github` != '';
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_identities` (`id`,`org_id`,`contact_id`,`kind`,`value_normalized`,`scope`,`raw`,`created_at`) SELECT lower(hex(randomblob(16))), `org_id`, `id`, 'threads_handle', `threads_handle`, '', `threads_handle`, `created_at` FROM `contacts` WHERE `threads_handle` IS NOT NULL AND `threads_handle` != '';
