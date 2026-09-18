-- Phase 4: converge Event onto one canonical TemporalRange truth.
--
-- Breaking semantic migration:
--   legacy all-day  -> when={kind:'date',start:startDate,endExclusive:endDateExclusive}
--   legacy timed    -> when={kind:'instant',start:startAt,endExclusive:endAt}
--
-- startTimezone/endTimezone are intentionally not persisted in the canonical Event.
-- Instant is already an absolute timestamp; viewing timezone belongs to query/presentation
-- context. The replacement table uses the exact Physical Schema Compiler shape for the
-- current baseline Event definition. Its NOT NULL/range checks make corrupt legacy rows
-- fail the migration rather than silently inventing data.

CREATE TABLE migration_0041_preflight_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_event_count INTEGER NOT NULL CHECK(published_event_count = 1),
  expected_event_count INTEGER NOT NULL CHECK(expected_event_count = 1)
);

INSERT INTO migration_0041_preflight_guard(id,published_event_count,expected_event_count)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published'),
  (SELECT COUNT(*) FROM model_definitions
    WHERE model_key='event' AND state='published'
      AND schema_hash='35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f');

DROP TABLE migration_0041_preflight_guard;

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published'
  AND schema_hash='35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_event_temporal_range_20260917',
  'event',
  'event',
  version+1,
  'published',
  1,
  '{"access":["read","write"],"capabilities":{"calendar":{"attendeePersonField":"attendeePersonIds","rangeField":"when"}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。","display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"description":"People attending or participating in the occurrence.","title":"Attendees","type":"person_list"},"description":{"description":"Optional details about the occurrence.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"location":{"description":"Where the occurrence happens, when explicitly provided.","maxLength":500,"nullable":true,"title":"Location","type":"string"},"status":{"description":"Current lifecycle state of the event.","required":true,"title":"Status","type":"enum","values":["active","cancelled"]},"summary":{"description":"A concise name for the calendar occurrence.","maxLength":100,"minLength":1,"required":true,"title":"Summary","type":"string"},"when":{"description":"When the occurrence happens. Use the date variant for all-day/date-only events and the instant variant for timed events.","required":true,"title":"When","type":"temporal_range"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","when","attendeePersonIds"],"searchable":["summary","description","location"],"sortable":["when","summary"]}}',
  'be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a',
  'breaking',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace schema 41 migration',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions
WHERE model_key='event' AND state='superseded'
  AND schema_hash='35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f'
ORDER BY version DESC LIMIT 1;

CREATE TABLE "mdl_event_temporal_range" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "description" TEXT,
  "location" TEXT,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('active','cancelled')),
  "summary" TEXT NOT NULL,
  "__tr_when_kind" TEXT NOT NULL CHECK("__tr_when_kind" IS NULL OR "__tr_when_kind" IN ('date','instant')),
  "__tr_when_start" TEXT NOT NULL,
  "__tr_when_end" TEXT NOT NULL CHECK(("__tr_when_kind" IS NULL AND "__tr_when_start" IS NULL AND "__tr_when_end" IS NULL) OR ("__tr_when_kind" IS NOT NULL AND "__tr_when_start" IS NOT NULL AND "__tr_when_end" IS NOT NULL AND "__tr_when_start" < "__tr_when_end")),
  UNIQUE(space_id,record_id)
);

INSERT INTO "mdl_event_temporal_range"(
  record_id,space_id,"description","location","status","summary",
  "__tr_when_kind","__tr_when_start","__tr_when_end"
)
SELECT
  record_id,
  space_id,
  "description",
  "location",
  "status",
  "summary",
  CASE WHEN "isAllDay"=1 THEN 'date' ELSE 'instant' END,
  CASE WHEN "isAllDay"=1 THEN "startDate" ELSE "startAt" END,
  CASE WHEN "isAllDay"=1 THEN "endDateExclusive" ELSE "endAt" END
FROM "mdl_event";

DROP TABLE "mdl_event";
ALTER TABLE "mdl_event_temporal_range" RENAME TO "mdl_event";

CREATE INDEX "idx_mdl_event_status" ON "mdl_event"(space_id,"status",record_id);
CREATE INDEX "idx_mdl_event_summary" ON "mdl_event"(space_id,"summary",record_id);
CREATE INDEX "idx_mdl_event_when" ON "mdl_event"(space_id,"__tr_when_kind","__tr_when_start","__tr_when_end",record_id);

UPDATE resource_records
SET model_version=(
  SELECT version FROM model_definitions
  WHERE model_key='event' AND state='published'
)
WHERE model_key='event';

CREATE TABLE migration_0041_post_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_event_count INTEGER NOT NULL CHECK(published_event_count = 1),
  expected_event_count INTEGER NOT NULL CHECK(expected_event_count = 1),
  migrated_resource_count INTEGER NOT NULL,
  migrated_storage_count INTEGER NOT NULL,
  CHECK(migrated_resource_count = migrated_storage_count)
);

INSERT INTO migration_0041_post_guard(
  id,published_event_count,expected_event_count,migrated_resource_count,migrated_storage_count
)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published'),
  (SELECT COUNT(*) FROM model_definitions
    WHERE model_key='event' AND state='published'
      AND schema_hash='be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a'),
  (SELECT COUNT(*) FROM resource_records WHERE model_key='event'),
  (SELECT COUNT(*) FROM mdl_event);

DROP TABLE migration_0041_post_guard;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='41' WHERE key='schema_version';
