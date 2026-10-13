-- Bounded Provider presence observation, identity metadata only (no record payload/history).
ALTER TABLE external_record_identities ADD COLUMN availability TEXT NOT NULL DEFAULT 'active' CHECK(availability IN ('active','unavailable'));
ALTER TABLE external_record_identities ADD COLUMN observed_at TEXT;
ALTER TABLE external_record_identities ADD COLUMN next_check_at TEXT;
CREATE INDEX idx_external_identity_due ON external_record_identities(next_check_at,record_id) WHERE next_check_at IS NOT NULL;
CREATE INDEX idx_external_identity_binding ON external_record_identities(model_key,record_id);
CREATE TRIGGER external_identity_source_park AFTER UPDATE OF status ON external_sources WHEN NEW.status='disabled'
BEGIN
 UPDATE external_record_identities SET next_check_at=NULL WHERE model_key IN (SELECT model_key FROM external_models WHERE source_id=NEW.id);
END;
CREATE TRIGGER external_identity_source_resume AFTER UPDATE OF status ON external_sources WHEN NEW.status='active' AND OLD.status!='active'
BEGIN
 UPDATE external_record_identities SET next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model_key IN (SELECT model_key FROM external_models WHERE source_id=NEW.id AND status!='disabled' AND definition_key IS NOT NULL);
END;
CREATE TRIGGER external_identity_binding_park AFTER UPDATE OF status ON external_models WHEN NEW.status='disabled'
BEGIN
 UPDATE external_record_identities SET next_check_at=NULL WHERE model_key=NEW.model_key;
END;
CREATE TRIGGER external_identity_binding_resume AFTER UPDATE OF status ON external_models WHEN NEW.status!='disabled' AND OLD.status='disabled'
BEGIN
 UPDATE external_record_identities SET next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model_key=NEW.model_key;
END;
DROP TRIGGER trg_semantic_relation_live_endpoints;
CREATE TRIGGER trg_semantic_relation_live_endpoints BEFORE INSERT ON semantic_relations WHEN NOT (EXISTS(SELECT 1 FROM resource_records r WHERE r.id=NEW.source_record_id AND r.space_id=NEW.space_id AND r.model_key=NEW.source_model_key AND r.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published' WHERE i.record_id=NEW.source_record_id AND i.space_id=NEW.space_id AND i.availability='active' AND m.space_id=NEW.space_id AND m.definition_key=NEW.source_model_key AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external')) OR NOT (EXISTS(SELECT 1 FROM resource_records r WHERE r.id=NEW.target_record_id AND r.space_id=NEW.space_id AND r.model_key=NEW.target_model_key AND r.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published' WHERE i.record_id=NEW.target_record_id AND i.space_id=NEW.space_id AND i.availability='active' AND m.space_id=NEW.space_id AND m.definition_key=NEW.target_model_key AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external')) BEGIN SELECT RAISE(ABORT,'SEMANTIC_RELATION_ENDPOINT_UNAVAILABLE');
END;
CREATE TRIGGER external_identity_definition_retire AFTER UPDATE OF state ON model_definitions WHEN NEW.state='retired'
BEGIN
 UPDATE external_record_identities SET next_check_at=NULL WHERE model_key IN (SELECT model_key FROM external_models WHERE definition_key=NEW.model_key);
END;
UPDATE schema_metadata SET value='61' WHERE key='schema_version';
