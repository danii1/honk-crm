-- Multi-seat teams: per-org seat limit (null = unlimited; counts members only, never API keys).
ALTER TABLE `organization` ADD `seat_limit` integer;--> statement-breakpoint
-- activity_log stays append-only, except when its organization is being deleted (delete_org cascade).
DROP TRIGGER IF EXISTS activity_log_no_delete;--> statement-breakpoint
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
WHEN EXISTS (SELECT 1 FROM organization WHERE id = OLD.org_id)
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
