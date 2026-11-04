CREATE TABLE `blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_org_kind_value_uq` ON `blocklist` (`org_id`,`kind`,`value`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`offer_text` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_org_name_uq` ON `campaigns` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `channel_states` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`last_touch_at` integer,
	`next_followup_at` integer,
	`next_step` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_states_org_contact_channel_uq` ON `channel_states` (`org_id`,`contact_id`,`channel`);--> statement-breakpoint
CREATE INDEX `channel_states_org_followup_idx` ON `channel_states` (`org_id`,`next_followup_at`);--> statement-breakpoint
CREATE INDEX `channel_states_org_channel_stage_idx` ON `channel_states` (`org_id`,`channel`,`stage`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`campaign_id` text,
	`text` text NOT NULL,
	`intent_url` text,
	`state` text DEFAULT 'drafted' NOT NULL,
	`state_changed_at` integer,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `drafts_org_state_idx` ON `drafts` (`org_id`,`state`);--> statement-breakpoint
CREATE INDEX `drafts_org_contact_idx` ON `drafts` (`org_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `drafts_org_channel_created_idx` ON `drafts` (`org_id`,`channel`,`created_at`);--> statement-breakpoint
ALTER TABLE `companies` ADD `team_size` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `stack` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `type` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `published_email` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `reddit_user` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `github` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `campaign_id` text REFERENCES campaigns(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `contacts` ADD `contact_type` text DEFAULT 'lead' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `source` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `bio_summary` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `followers` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `est_team_size` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `signal_post_url` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `signal_date` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `signal_summary` text;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_linkedin_uq` ON `contacts` (`org_id`,`linkedin`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_x_uq` ON `contacts` (`org_id`,`x`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_reddit_uq` ON `contacts` (`org_id`,`reddit_user`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_github_uq` ON `contacts` (`org_id`,`github`);--> statement-breakpoint
CREATE INDEX `contacts_org_source_idx` ON `contacts` (`org_id`,`source`);--> statement-breakpoint
CREATE INDEX `contacts_org_campaign_idx` ON `contacts` (`org_id`,`campaign_id`);--> statement-breakpoint
-- v1 -> v2 stage names
UPDATE `contacts` SET `stage` = CASE `stage` WHEN 'replied' THEN 'responded' WHEN 'meeting' THEN 'call_booked' WHEN 'won' THEN 'paying' ELSE `stage` END;
