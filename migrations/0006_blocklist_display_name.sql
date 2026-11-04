ALTER TABLE `blocklist` ADD `display_name` text;--> statement-breakpoint
UPDATE `blocklist` SET `display_name` = `label` WHERE `display_name` IS NULL;
