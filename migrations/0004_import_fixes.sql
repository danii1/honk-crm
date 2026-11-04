ALTER TABLE `blocklist` ADD `match` text DEFAULT 'fuzzy' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `source_detail` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `est_team_size_text` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `score_original` text;--> statement-breakpoint
UPDATE `blocklist` SET `match` = 'exact' WHERE `kind` = 'name' AND instr(`value`, ' ') = 0 AND length(`value`) <= 7 AND instr(trim(coalesce(`label`, `value`)), ' ') = 0 AND length(trim(coalesce(`label`, `value`))) <= 7;
