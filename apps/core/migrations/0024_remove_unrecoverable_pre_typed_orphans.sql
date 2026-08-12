-- Phase 3 pre-HomeMew-cutover repair for records created before typed storage.
--
-- Migration 0022 introduced the proving-model mdl_* tables but deliberately did
-- not backfill the intermediate resource_records.data_json representation.
-- Migration 0023 then retired data_json/resource_index_values after staging had
-- converged to the typed runtime. Any older envelope that never obtained a
-- corresponding typed row is therefore no longer recoverable or serviceable.
--
-- HomeMew has not cut over to LifeSpace and Phase 3 explicitly permits dropping
-- this discarded intermediate staging representation. Do not synthesize typed
-- business values for these rows. Remove incoming record relations first because
-- target_record_id is intentionally not ON DELETE CASCADE; source relations,
-- Temporal occurrences, and typed rows use cascading foreign keys.

DELETE FROM resource_relations
WHERE target_record_id IN (
  SELECT r.id
  FROM resource_records r
  WHERE
    (r.model_key='task' AND NOT EXISTS (
      SELECT 1 FROM mdl_task m WHERE m.record_id=r.id AND m.space_id=r.space_id
    ))
    OR (r.model_key='wish' AND NOT EXISTS (
      SELECT 1 FROM mdl_wish m WHERE m.record_id=r.id AND m.space_id=r.space_id
    ))
    OR (r.model_key='day_record' AND NOT EXISTS (
      SELECT 1 FROM mdl_day_record m WHERE m.record_id=r.id AND m.space_id=r.space_id
    ))
    OR (r.model_key='event' AND NOT EXISTS (
      SELECT 1 FROM mdl_event m WHERE m.record_id=r.id AND m.space_id=r.space_id
    ))
);

DELETE FROM resource_records
WHERE
  (model_key='task' AND NOT EXISTS (
    SELECT 1 FROM mdl_task m WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
  ))
  OR (model_key='wish' AND NOT EXISTS (
    SELECT 1 FROM mdl_wish m WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
  ))
  OR (model_key='day_record' AND NOT EXISTS (
    SELECT 1 FROM mdl_day_record m WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
  ))
  OR (model_key='event' AND NOT EXISTS (
    SELECT 1 FROM mdl_event m WHERE m.record_id=resource_records.id AND m.space_id=resource_records.space_id
  ));

UPDATE schema_metadata
SET value='24'
WHERE key='schema_version';
