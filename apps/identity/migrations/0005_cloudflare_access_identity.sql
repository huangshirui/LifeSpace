PRAGMA foreign_keys = ON;

CREATE TABLE access_audiences (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX uq_access_audience ON access_audiences(issuer, audience);
CREATE INDEX idx_access_audiences_application ON access_audiences(application_id, status);

CREATE TABLE access_principals (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  email_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  linked_at TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_access_principal ON access_principals(issuer, subject);
CREATE INDEX idx_access_principals_user ON access_principals(user_id, status);

CREATE TABLE access_link_challenges (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  audience TEXT NOT NULL,
  email_snapshot TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  linked_user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_access_link_challenges_principal ON access_link_challenges(issuer, subject, consumed_at);
CREATE INDEX idx_access_link_challenges_expiry ON access_link_challenges(expires_at, consumed_at);

UPDATE schema_metadata SET value = '5' WHERE key = 'schema_version';
