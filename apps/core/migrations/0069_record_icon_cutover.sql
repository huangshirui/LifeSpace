-- One-time BREAKING cutover: DayRecord data.icon -> universal Record presentation.icon.
-- This migration intentionally has NO compatibility alias for older HomeMew Mini clients.
-- Before applying to production, audit all nonempty icon values; the original DayRecord
-- UI only wrote Emoji, and unexpected non-Emoji values must be corrected before cutover.
--
-- D1 icon_json is nullable (null means no icon). Native record identity remains unchanged.
ALTER TABLE resource_records ADD COLUMN icon_json TEXT
  CHECK (icon_json IS NULL OR (json_valid(icon_json) AND json_type(icon_json,'$.type') IN ('emoji','image')));

-- Keep the original text, without changing multi-codepoint Emoji sequences.
UPDATE resource_records
SET icon_json=json_object('type','emoji','value',(
  SELECT m.icon FROM mdl_day_record m WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
))
WHERE model_key='day_record' AND deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM mdl_day_record m
    WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
    AND m.icon IS NOT NULL AND length(trim(m.icon))>0);

-- No historical DayRecord data.icon column is retained.
ALTER TABLE mdl_day_record DROP COLUMN icon;

-- Publish the revised canonical Baseline Model as an explicit breaking version.
-- Hash is SHA-256(canonicalModelDefinition(day_record without fields.icon)).
UPDATE model_definitions SET state='superseded',
  superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='day_record' AND state='published'
  AND schema_hash<>'3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_day_record_record_icon_20261020','day_record',latest.route_segment,
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='day_record'),0)+1,
  'published',1,
  json_remove(latest.definition_json,'$.fields.icon'),
  '3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7',
  'breaking','service','svc_lifespace_bootstrap','LifeSpace Record Icon schema 69 migration'
FROM model_definitions latest
WHERE latest.model_key='day_record' AND latest.state='superseded'
  AND latest.version=(SELECT MAX(version) FROM model_definitions WHERE model_key='day_record')
  AND NOT EXISTS (
    SELECT 1 FROM model_definitions WHERE model_key='day_record' AND state='published'
      AND schema_hash='3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7'
  );

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;
DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='69' WHERE key='schema_version';
