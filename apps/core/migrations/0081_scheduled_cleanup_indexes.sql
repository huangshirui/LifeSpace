-- Core Schema 81: pending-work indexes, not retained history. No row backfill,
-- deletion, retention change or public contract change. Apply before new Core.
CREATE INDEX idx_file_upload_sessions_due
  ON file_upload_sessions(status,expires_at,created_at,id)
  WHERE cleaned_at IS NULL AND status IN ('pending','executing','unknown');
CREATE INDEX idx_file_upload_sessions_terminal
  ON file_upload_sessions(created_at,id)
  WHERE cleaned_at IS NULL AND status IN ('failed','completed');
CREATE INDEX idx_files_deletion_due
  ON files(deletion_requested_at,id,object_key)
  WHERE status='deleting';
-- The prior broad cleanup index includes completed/cleaned history. The only
-- runtime sweep is replaced by the two pending-only indexes above. Preserve
-- space and native File origin indexes. Old Worker SQL remains valid on rollback.
DROP INDEX idx_file_upload_sessions_cleanup;
UPDATE schema_metadata SET value='81' WHERE key='schema_version';
