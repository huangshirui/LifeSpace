-- External Connection access is a hard ceiling over every binding on that
-- Connection. Keep this invariant in D1 so all current/future control-plane
-- callers fail closed even when they bypass a particular HTTP route.
CREATE TRIGGER external_sources_read_ceiling
AFTER UPDATE OF access_mode ON external_sources
WHEN NEW.access_mode = 'read' AND COALESCE(OLD.access_mode, '') != 'read'
BEGIN
  UPDATE external_models
  SET declared_access = 'read',
      updated_at = NEW.updated_at
  WHERE source_id = NEW.id
    AND declared_access = 'write';
END;

UPDATE schema_metadata SET value='64' WHERE key='schema_version';
