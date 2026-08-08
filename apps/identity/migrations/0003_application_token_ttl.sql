PRAGMA foreign_keys = ON;

ALTER TABLE applications
ADD COLUMN access_token_ttl_seconds INTEGER NOT NULL DEFAULT 900
CHECK (access_token_ttl_seconds BETWEEN 300 AND 3600);

UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version';
