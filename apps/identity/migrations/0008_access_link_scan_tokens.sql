PRAGMA foreign_keys = ON;

ALTER TABLE access_link_challenges ADD COLUMN scan_token_hash TEXT;

CREATE UNIQUE INDEX uq_access_link_challenges_scan_token_hash
  ON access_link_challenges(scan_token_hash);

UPDATE schema_metadata SET value = '8' WHERE key = 'schema_version';
