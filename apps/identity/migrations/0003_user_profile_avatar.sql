ALTER TABLE users ADD COLUMN avatar_key TEXT;

CREATE INDEX idx_users_status ON users(status);

UPDATE schema_metadata SET value='3' WHERE key='schema_version';
