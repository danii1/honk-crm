CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`thread_id` text,
	`summary` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_org_channel_type_external_uq` ON `events` (`org_id`,`channel`,`type`,`external_id`);--> statement-breakpoint
CREATE INDEX `events_org_channel_thread_idx` ON `events` (`org_id`,`channel`,`thread_id`);--> statement-breakpoint
CREATE INDEX `events_org_occurred_idx` ON `events` (`org_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `org_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`followup_rules` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `threads_handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_threads_uq` ON `contacts` (`org_id`,`threads_handle`);--> statement-breakpoint
ALTER TABLE `drafts` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `drafts_org_channel_thread_idx` ON `drafts` (`org_id`,`channel`,`thread_id`);--> statement-breakpoint
CREATE INDEX `drafts_org_external_idx` ON `drafts` (`org_id`,`external_id`);--> statement-breakpoint
ALTER TABLE `outreach_touches` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `outreach_touches` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `touches_org_channel_thread_idx` ON `outreach_touches` (`org_id`,`channel`,`thread_id`);