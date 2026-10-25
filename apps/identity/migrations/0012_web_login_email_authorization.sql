CREATE TABLE web_login_emails (
  user_id TEXT NOT NULL REFERENCES users(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  issuer TEXT NOT NULL,
  email TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, application_id),
  UNIQUE(application_id, issuer, email)
);
CREATE TABLE web_login_email_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  version INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
UPDATE schema_metadata SET value='12' WHERE key='schema_version';
