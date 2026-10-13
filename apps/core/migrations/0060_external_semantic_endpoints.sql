DROP TRIGGER trg_semantic_relations_cleanup_on_record_delete;
DROP TRIGGER trg_semantic_relation_live_endpoints;
CREATE TABLE semantic_relations_next (
  id TEXT PRIMARY KEY CHECK(id GLOB 'rel_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source_model_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  target_model_key TEXT NOT NULL,
  target_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id)
);

INSERT INTO semantic_relations_next SELECT * FROM semantic_relations;
DROP TABLE semantic_relations;
ALTER TABLE semantic_relations_next RENAME TO semantic_relations;
CREATE INDEX idx_semantic_relations_source
  ON semantic_relations(space_id,source_model_key,source_record_id,predicate,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_target
  ON semantic_relations(space_id,target_model_key,target_record_id,predicate,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_predicate
  ON semantic_relations(space_id,predicate,created_at DESC,id DESC);

CREATE INDEX idx_semantic_relations_source_time
  ON semantic_relations(space_id,source_model_key,source_record_id,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_target_time
  ON semantic_relations(space_id,target_model_key,target_record_id,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_space_time
  ON semantic_relations(space_id,created_at DESC,id DESC);

CREATE TRIGGER trg_semantic_relation_live_endpoints BEFORE INSERT ON semantic_relations WHEN NOT (EXISTS(SELECT 1 FROM resource_records r WHERE r.id=NEW.source_record_id AND r.space_id=NEW.space_id AND r.model_key=NEW.source_model_key AND r.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published' WHERE i.record_id=NEW.source_record_id AND i.space_id=NEW.space_id AND m.space_id=NEW.space_id AND m.definition_key=NEW.source_model_key AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external')) OR NOT (EXISTS(SELECT 1 FROM resource_records r WHERE r.id=NEW.target_record_id AND r.space_id=NEW.space_id AND r.model_key=NEW.target_model_key AND r.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published' WHERE i.record_id=NEW.target_record_id AND i.space_id=NEW.space_id AND m.space_id=NEW.space_id AND m.definition_key=NEW.target_model_key AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external')) BEGIN SELECT RAISE(ABORT,'SEMANTIC_RELATION_ENDPOINT_UNAVAILABLE'); END;
CREATE TRIGGER trg_semantic_relations_cleanup_on_record_delete
AFTER INSERT ON resource_changes
WHEN NEW.operation='delete'
BEGIN
  INSERT INTO semantic_relation_changes(
    id,relation_id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,operation,principal_type,principal_id,
    actor_type,actor_id,application_id,delegation_id,source_resource_change_id,
    change_set_id,occurred_at
  )
  SELECT
    'chg_' || lower(hex(randomblob(16))),id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,'endpoint_delete',NEW.principal_type,NEW.principal_id,
    NEW.actor_type,NEW.actor_id,NEW.application_id,NEW.delegation_id,NEW.id,
    NEW.change_set_id,NEW.occurred_at
  FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND source_model_key=NEW.model_key
    AND source_record_id=NEW.record_id;

  INSERT INTO semantic_relation_changes(
    id,relation_id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,operation,principal_type,principal_id,
    actor_type,actor_id,application_id,delegation_id,source_resource_change_id,
    change_set_id,occurred_at
  )
  SELECT
    'chg_' || lower(hex(randomblob(16))),id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,'endpoint_delete',NEW.principal_type,NEW.principal_id,
    NEW.actor_type,NEW.actor_id,NEW.application_id,NEW.delegation_id,NEW.id,
    NEW.change_set_id,NEW.occurred_at
  FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND target_model_key=NEW.model_key
    AND target_record_id=NEW.record_id
    AND source_record_id<>NEW.record_id;

  DELETE FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND source_model_key=NEW.model_key
    AND source_record_id=NEW.record_id;

  DELETE FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND target_model_key=NEW.model_key
    AND target_record_id=NEW.record_id;
END;

CREATE TRIGGER external_semantic_identity_cleanup AFTER DELETE ON external_record_identities
BEGIN
 DELETE FROM semantic_relations WHERE space_id=OLD.space_id AND source_record_id=OLD.record_id;
 DELETE FROM semantic_relations WHERE space_id=OLD.space_id AND target_record_id=OLD.record_id;
END;
UPDATE schema_metadata SET value='60' WHERE key='schema_version';
