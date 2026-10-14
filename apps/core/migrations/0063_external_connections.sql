-- Product-facing External Connection metadata. Provider credential plaintext remains Adapter-owned.
ALTER TABLE external_sources ADD COLUMN display_name TEXT;
ALTER TABLE external_sources ADD COLUMN access_mode TEXT CHECK(access_mode IS NULL OR access_mode IN ('read','write'));
ALTER TABLE external_sources ADD COLUMN created_by_user_id TEXT;
ALTER TABLE external_sources ADD COLUMN revoked_at TEXT;

CREATE INDEX idx_external_sources_space_connection
  ON external_sources(space_id,revoked_at,status,created_at,id);

UPDATE schema_metadata SET value='63' WHERE key='schema_version';
