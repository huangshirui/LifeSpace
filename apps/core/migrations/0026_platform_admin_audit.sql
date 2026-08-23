PRAGMA foreign_keys = ON;

CREATE TABLE platform_admin_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_application_id TEXT NOT NULL,
  actor_token_id TEXT NOT NULL,
  executor_principal_id TEXT NOT NULL,
  executor_application_id TEXT NOT NULL,
  executor_token_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('pending','success','failure')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_platform_admin_audit_created
  ON platform_admin_audit(created_at DESC, id);
CREATE INDEX idx_platform_admin_audit_actor
  ON platform_admin_audit(actor_user_id, created_at DESC);
CREATE INDEX idx_platform_admin_audit_target
  ON platform_admin_audit(target_type, target_id, created_at DESC);

UPDATE schema_metadata
SET value='26'
WHERE key='schema_version';
