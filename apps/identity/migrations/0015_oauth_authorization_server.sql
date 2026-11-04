-- OAuth Authorization Server state is separate from existing Service client_credentials.
-- All plaintext codes/tokens are returned only once; database stores SHA-256 hashes.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_authorization_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  state TEXT,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_requests_expiry ON oauth_authorization_requests(expires_at);
CREATE TABLE oauth_authorizations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES oauth_authorization_requests(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  space_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  allow_user_authorization INTEGER NOT NULL CHECK(allow_user_authorization IN (0,1)),
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX oauth_authorizations_user ON oauth_authorizations(user_id,status,created_at);
CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES oauth_authorizations(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES oauth_authorizations(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX oauth_access_by_auth ON oauth_access_tokens(authorization_id);
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES oauth_authorizations(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  family_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX oauth_refresh_by_auth ON oauth_refresh_tokens(authorization_id);
UPDATE schema_metadata SET value='15' WHERE key='schema_version';
