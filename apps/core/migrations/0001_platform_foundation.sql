PRAGMA foreign_keys = ON;

CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_metadata (key, value) VALUES ('schema_version', '1');

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal','family','team')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TEXT
);
CREATE INDEX idx_spaces_created_by ON spaces(created_by_user_id, deleted_at);

CREATE TABLE space_memberships (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX uq_active_space_membership ON space_memberships(space_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_space_memberships_user ON space_memberships(user_id, deleted_at);

CREATE TABLE space_people (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  linked_user_id TEXT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX uq_active_space_person_user ON space_people(space_id, linked_user_id) WHERE linked_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_space_people_space ON space_people(space_id, deleted_at);

CREATE TABLE data_grants (
  id TEXT PRIMARY KEY,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','space','service','device')),
  grantee_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('free_busy','read','write','manage')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_data_grants_grantee ON data_grants(grantee_type, grantee_id, revoked_at, expires_at);
CREATE INDEX idx_data_grants_source ON data_grants(source_space_id, resource_type, resource_id, revoked_at);
