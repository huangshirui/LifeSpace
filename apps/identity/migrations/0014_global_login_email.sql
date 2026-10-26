-- Canonical, global user-owned login mailbox. It is not an Access principal.
-- Do not rewrite applied 0012/0013 history.
ALTER TABLE access_principals ADD COLUMN linked_via_email INTEGER NOT NULL DEFAULT 0 CHECK(linked_via_email IN (0,1));

CREATE TABLE user_login_emails (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Preserve historical principal mappings. Backfill only unambiguous, active
-- mailbox declarations (pending preferred, then newest completed identity).
-- Ambiguous cross-user snapshots are recorded for explicit reconciliation;
-- never silently choose a user's account based on conflicting metadata.
CREATE TABLE login_email_migration_conflicts (
  email TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(email,user_id,principal_id)
);
INSERT INTO login_email_migration_conflicts(email,user_id,principal_id,created_at)
SELECT lower(trim(p.email_snapshot)),p.user_id,p.id,datetime('now')
FROM access_principals p
WHERE p.status='active' AND p.email_snapshot IS NOT NULL AND trim(p.email_snapshot)<>''
AND EXISTS (
 SELECT 1 FROM access_principals other
 WHERE other.status='active' AND other.user_id<>p.user_id
 AND lower(trim(other.email_snapshot))=lower(trim(p.email_snapshot))
);

INSERT INTO user_login_emails(user_id,email,created_at,updated_at)
SELECT p.user_id,lower(trim(p.email_snapshot)),p.linked_at,p.updated_at
FROM access_principals p
JOIN users u ON u.id=p.user_id AND u.status='active'
WHERE p.status='active' AND p.email_snapshot IS NOT NULL AND trim(p.email_snapshot)<>''
AND p.id=(
 SELECT q.id FROM access_principals q
 WHERE q.user_id=p.user_id AND q.status='active'
 AND q.email_snapshot IS NOT NULL AND trim(q.email_snapshot)<>''
 ORDER BY (q.subject IS NULL) DESC,q.link_version DESC,q.linked_at DESC,q.id DESC LIMIT 1
)
AND NOT EXISTS (
 SELECT 1 FROM login_email_migration_conflicts c
 WHERE c.email=lower(trim(p.email_snapshot))
);
-- Legacy subject-less placeholder rows cease to have auth semantics.
-- Email reservations now live exclusively in user_login_emails.
UPDATE access_principals SET status='disabled',updated_at=datetime('now')
WHERE subject IS NULL AND status='active';

UPDATE schema_metadata SET value='14' WHERE key='schema_version';
