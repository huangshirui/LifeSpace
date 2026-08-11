ALTER TABLE spaces ADD COLUMN avatar_key TEXT;

UPDATE schema_metadata SET value='8' WHERE key='schema_version';
