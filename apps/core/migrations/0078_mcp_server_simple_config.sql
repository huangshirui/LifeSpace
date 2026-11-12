-- Core Schema 78: MCP Server is a directly editable configuration.
-- Preserve previously effective published configuration, not unpublished drafts.
CREATE TABLE mcp_server_settings_v2 (
  id TEXT PRIMARY KEY CHECK (id LIKE 'mcp_%'),
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO mcp_server_settings_v2
  (id,display_name,description,enabled,config_json,revision,created_by_user_id,updated_by_user_id,created_at,updated_at)
SELECT
  d.id,d.display_name,d.description,
  CASE WHEN d.status='published' AND p.manifest_json IS NOT NULL THEN 1 ELSE 0 END,
  CASE WHEN d.status='published' AND p.manifest_json IS NOT NULL THEN
    json_patch(
      json_object('models',json((SELECT json_group_array(json_object(
        'modelKey',json_extract(m.value,'$.modelKey'),
        'operations',json_extract(m.value,'$.operations')
      )) FROM json_each(p.manifest_json,'$.models') AS m))),
      CASE WHEN json_type(p.manifest_json,'$.resources')='array' THEN
        json_object('resources',json((SELECT json_group_array(json_object(
          'resourceKey',json_extract(r.value,'$.resourceKey'),
          'operations',json_extract(r.value,'$.operations')
        )) FROM json_each(p.manifest_json,'$.resources') AS r)))
      ELSE '{}' END
    )
  ELSE d.draft_json END,
  MAX(d.draft_revision,1),
  d.created_by_user_id,d.updated_by_user_id,d.created_at,d.updated_at
FROM mcp_server_definitions AS d
LEFT JOIN mcp_server_publications AS p
  ON p.server_id=d.id AND p.revision=d.published_revision;
DROP TRIGGER mcp_server_publication_immutable_update;
DROP TRIGGER mcp_server_publication_immutable_delete;
DROP TABLE mcp_server_publications;
DROP TABLE mcp_server_definitions;
ALTER TABLE mcp_server_settings_v2 RENAME TO mcp_server_definitions;
CREATE INDEX idx_mcp_server_settings_enabled ON mcp_server_definitions(enabled,display_name);
UPDATE schema_metadata SET value='78' WHERE key='schema_version';
