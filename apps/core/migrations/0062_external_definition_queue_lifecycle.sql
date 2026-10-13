-- Definition lifecycle is part of executable work, not a post-LIMIT filter.
UPDATE external_models SET next_refresh_at=NULL
WHERE definition_key IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM model_definitions d WHERE d.model_key=definition_key
 AND d.state='published' AND json_extract(d.definition_json,'$.origin')='external'
);

CREATE TRIGGER external_definition_refresh_park AFTER UPDATE OF state ON model_definitions
WHEN OLD.state='published' AND NEW.state='retired' AND json_extract(NEW.definition_json,'$.origin')='external'
BEGIN
 UPDATE external_models SET next_refresh_at=NULL WHERE definition_key=NEW.model_key;
END;

CREATE TRIGGER external_definition_queues_resume AFTER INSERT ON model_definitions
WHEN NEW.state='published' AND json_extract(NEW.definition_json,'$.origin')='external'
BEGIN
 UPDATE external_models SET next_refresh_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE definition_key=NEW.model_key AND status!='disabled'
 AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=source_id AND s.status='active')
 AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=space_id AND s.deleted_at IS NULL);
 UPDATE external_record_identities SET next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE model_key IN (SELECT m.model_key FROM external_models m
  JOIN external_sources s ON s.id=m.source_id JOIN spaces sp ON sp.id=m.space_id
  WHERE m.definition_key=NEW.model_key AND m.status!='disabled' AND s.status='active' AND sp.deleted_at IS NULL);
END;

DROP TRIGGER external_source_refresh_lifecycle;
CREATE TRIGGER external_source_refresh_lifecycle AFTER UPDATE OF status ON external_sources
WHEN OLD.status!=NEW.status
BEGIN
 UPDATE external_models SET next_refresh_at=NULL WHERE source_id=NEW.id;
 UPDATE external_models SET next_refresh_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE source_id=NEW.id AND NEW.status='active' AND status!='disabled'
 AND (definition_key IS NULL OR EXISTS(SELECT 1 FROM model_definitions d
  WHERE d.model_key=definition_key AND d.state='published' AND json_extract(d.definition_json,'$.origin')='external'));
END;

DROP TRIGGER external_identity_source_resume;
CREATE TRIGGER external_identity_source_resume AFTER UPDATE OF status ON external_sources
WHEN NEW.status='active' AND OLD.status!='active'
BEGIN
 UPDATE external_record_identities SET next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE model_key IN (SELECT m.model_key FROM external_models m
  JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published'
  WHERE m.source_id=NEW.id AND m.status!='disabled' AND json_extract(d.definition_json,'$.origin')='external');
END;

UPDATE schema_metadata SET value='62' WHERE key='schema_version';
