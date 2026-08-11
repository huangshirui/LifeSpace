PRAGMA foreign_keys = ON;

CREATE TABLE service_principals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  max_scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX idx_service_principals_application ON service_principals(application_id, status);
CREATE INDEX idx_service_principals_creator ON service_principals(created_by_user_id, status);

CREATE TABLE service_api_tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES service_principals(id),
  token_hash_version INTEGER NOT NULL DEFAULT 1 CHECK (token_hash_version = 1),
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  last_four TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  scopes TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'lifespace-core' CHECK (audience = 'lifespace-core'),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_service_api_tokens_principal ON service_api_tokens(principal_id, revoked_at, expires_at);
CREATE INDEX idx_service_api_tokens_lookup ON service_api_tokens(token_hash, revoked_at);

CREATE TABLE service_oauth_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES service_principals(id),
  secret_hash TEXT NOT NULL UNIQUE,
  secret_suffix TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_service_oauth_credentials_principal ON service_oauth_credentials(principal_id, status);

UPDATE schema_metadata SET value = '4' WHERE key = 'schema_version';
