PRAGMA foreign_keys = ON;

CREATE TABLE platform_administrators (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  assigned_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_platform_administrators_status
  ON platform_administrators(status, assigned_at, user_id);

UPDATE schema_metadata SET value='7' WHERE key='schema_version';
