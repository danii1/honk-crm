-- Enforce append-only semantics for the audit log at the database level.
CREATE TRIGGER activity_log_no_update BEFORE UPDATE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
