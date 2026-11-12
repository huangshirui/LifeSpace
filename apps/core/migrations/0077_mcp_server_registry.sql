-- Schema 77: platform-owned MCP domain Server definitions and immutable publication history.
-- A published definition is a control-plane catalog entry, NOT an active MCP transport.
-- The adapter must consume published catalog revisions and enforce current Core authority.
CREATE TABLE mcp_server_definitions (
  id TEXT PRIMARY KEY CHECK (id LIKE 'mcp_%'),
  server_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision >= 1),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  withdrawn_at TEXT,
  CHECK (status = 'draft' OR published_revision IS NOT NULL)
);
CREATE TABLE mcp_server_publications (
  server_id TEXT NOT NULL REFERENCES mcp_server_definitions(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by_user_id TEXT NOT NULL,
  PRIMARY KEY (server_id, revision)
);
CREATE TRIGGER mcp_server_publication_immutable_update
BEFORE UPDATE ON mcp_server_publications
BEGIN SELECT RAISE(ABORT, 'MCP_PUBLICATION_IMMUTABLE'); END;
CREATE TRIGGER mcp_server_publication_immutable_delete
BEFORE DELETE ON mcp_server_publications
BEGIN SELECT RAISE(ABORT, 'MCP_PUBLICATION_IMMUTABLE'); END;
CREATE INDEX idx_mcp_servers_status_key ON mcp_server_definitions(status, server_key);
UPDATE schema_metadata SET value='77' WHERE key='schema_version';
