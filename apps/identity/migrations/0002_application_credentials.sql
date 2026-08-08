PRAGMA foreign_keys = ON;

DROP TABLE external_identities;

ALTER TABLE applications
ADD COLUMN trusted_backend INTEGER NOT NULL DEFAULT 0 CHECK (trusted_backend IN (0,1));

CREATE TABLE application_credentials (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  secret_hash TEXT NOT NULL UNIQUE,
  secret_suffix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_application_credentials_app ON application_credentials(application_id, status);

UPDATE schema_metadata SET value = '2' WHERE key = 'schema_version';
