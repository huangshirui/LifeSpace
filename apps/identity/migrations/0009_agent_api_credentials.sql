PRAGMA foreign_keys = ON;

CREATE TABLE agent_api_credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  token_hash_version INTEGER NOT NULL DEFAULT 1 CHECK (token_hash_version = 1),
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  last_four TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  scopes TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'lifespace-core' CHECK (audience = 'lifespace-core'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id),
  FOREIGN KEY(agent_id, application_id) REFERENCES agent_applications(agent_id, application_id)
);

CREATE INDEX idx_agent_api_credentials_binding
  ON agent_api_credentials(agent_id, application_id, status, revoked_at, expires_at);
CREATE INDEX idx_agent_api_credentials_lookup
  ON agent_api_credentials(token_hash, status, revoked_at);

UPDATE schema_metadata SET value='9' WHERE key='schema_version';
