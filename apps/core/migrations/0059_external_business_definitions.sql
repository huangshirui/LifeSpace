-- External business semantics reuse published Registry definitions. Bindings
-- remain Space-local and preserve provider-owned schema and record identity.
ALTER TABLE external_models ADD COLUMN definition_key TEXT;
CREATE UNIQUE INDEX idx_external_definition_binding ON external_models(space_id,definition_key)
WHERE definition_key IS NOT NULL AND status!='disabled';
CREATE TRIGGER external_binding_definition_insert BEFORE INSERT ON external_models
WHEN NEW.definition_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_definitions
  WHERE model_key=NEW.definition_key AND state='published' AND json_extract(definition_json,'$.origin')='external')
BEGIN SELECT RAISE(ABORT,'EXTERNAL_DEFINITION_UNAVAILABLE'); END;
CREATE TRIGGER external_binding_definition_update BEFORE UPDATE OF definition_key ON external_models
WHEN OLD.definition_key IS NOT NULL AND NEW.definition_key IS NOT OLD.definition_key
BEGIN SELECT RAISE(ABORT,'EXTERNAL_DEFINITION_IMMUTABLE'); END;
CREATE TRIGGER external_binding_definition_reactivate BEFORE UPDATE OF definition_key,status ON external_models
WHEN NEW.definition_key IS NOT NULL AND NEW.status!='disabled' AND NOT EXISTS(
 SELECT 1 FROM model_definitions WHERE model_key=NEW.definition_key AND state='published'
 AND json_extract(definition_json,'$.origin')='external')
BEGIN SELECT RAISE(ABORT,'EXTERNAL_DEFINITION_UNAVAILABLE'); END;
UPDATE schema_metadata SET value='59' WHERE key='schema_version';
