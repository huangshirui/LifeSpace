-- 0012 has executed in Staging; repair forward without rewriting history.
ALTER TABLE users ADD COLUMN access_link_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN access_link_operation_id TEXT;

CREATE TABLE access_principals_unified (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  email_snapshot TEXT,
  pending_application_id TEXT REFERENCES applications(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  linked_at TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(subject IS NOT NULL OR (pending_application_id IS NOT NULL AND email_snapshot IS NOT NULL))
);
INSERT INTO access_principals_unified(id,issuer,subject,user_id,email_snapshot,status,linked_at,last_seen_at,created_at,updated_at)
SELECT id,issuer,subject,user_id,email_snapshot,status,linked_at,last_seen_at,created_at,updated_at FROM access_principals;
DROP TABLE access_principals;
ALTER TABLE access_principals_unified RENAME TO access_principals;
CREATE UNIQUE INDEX uq_access_principal ON access_principals(issuer,subject) WHERE subject IS NOT NULL;
CREATE INDEX idx_access_principals_user ON access_principals(user_id,status);
CREATE UNIQUE INDEX uq_access_pending_user ON access_principals(user_id,pending_application_id,issuer) WHERE subject IS NULL AND status='active';
CREATE UNIQUE INDEX uq_access_pending_email ON access_principals(pending_application_id,issuer,lower(trim(email_snapshot))) WHERE subject IS NULL AND status='active';

CREATE TRIGGER access_pending_email_conflict BEFORE INSERT ON access_principals
WHEN NEW.subject IS NULL AND NEW.status='active' AND EXISTS(
 SELECT 1 FROM access_principals p WHERE p.issuer=NEW.issuer AND p.subject IS NOT NULL
 AND p.status='active' AND p.user_id<>NEW.user_id AND lower(trim(p.email_snapshot))=lower(trim(NEW.email_snapshot))
)
BEGIN SELECT RAISE(ABORT,'ACCESS_EMAIL_CONFLICT'); END;

UPDATE users SET access_link_version=COALESCE((SELECT max(version) FROM web_login_emails e WHERE e.user_id=users.id),0);
INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,pending_application_id,status,linked_at,created_at,updated_at)
SELECT 'acp_pending_'||lower(hex(randomblob(16))),e.issuer,NULL,e.user_id,lower(trim(e.email)),e.application_id,'active',e.updated_at,e.updated_at,e.updated_at
FROM web_login_emails e WHERE NOT EXISTS(
 SELECT 1 FROM access_principals p WHERE p.user_id=e.user_id AND p.issuer=e.issuer AND p.subject IS NOT NULL
 AND p.status='active' AND lower(trim(p.email_snapshot))=lower(trim(e.email))
);
ALTER TABLE web_login_email_audit RENAME TO access_link_audit;
DROP TABLE web_login_emails;
UPDATE schema_metadata SET value='13' WHERE key='schema_version';
