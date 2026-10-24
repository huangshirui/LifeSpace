-- Schema 74: BREAKING Event Location cutover after schema 73 (PR #404).
-- Requires LifeSpace Location kernel (PR #405) and coordinated HomeMew BFF
-- release. Existing non-empty Event.location strings are preserved as name-only
-- canonical Location values. No address or WGS84 coordinates are inferred.
--
-- Rollback: restore the verified pre-migration D1 snapshot and the previous
-- compatible application/worker versions; do not down-migrate by guessing.
-- The migration fails closed unless the old Event contract and schema 73 are live.

CREATE TABLE _schema74_preflight (
  id INTEGER PRIMARY KEY CHECK(id=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=73),
  event_published_count INTEGER NOT NULL CHECK(event_published_count=1),
  old_event_contract_count INTEGER NOT NULL CHECK(old_event_contract_count=1),
  record_count INTEGER NOT NULL,
  storage_count INTEGER NOT NULL,
  CHECK(record_count=storage_count)
);
INSERT INTO _schema74_preflight(id,schema_version,event_published_count,old_event_contract_count,record_count,storage_count)
SELECT 1,
 (SELECT CAST(value AS INTEGER) FROM schema_metadata WHERE key='schema_version'),
 (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published'),
 (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published' AND schema_hash='be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a'),
 (SELECT COUNT(*) FROM resource_records WHERE model_key='event'),
 (SELECT COUNT(*) FROM mdl_event);
DROP TABLE _schema74_preflight;

-- Keep the original registry row immutable as an inspectable historical contract.
UPDATE model_definitions
SET state='superseded', superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published' AND schema_hash='be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
 'mdl_catalog_event_location_20261024', 'event','event',
 COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='event'),0)+1,
 'published',1,'{"access":["read","write"],"capabilities":{"calendar":{"attendeePersonField":"attendeePersonIds","rangeField":"when"}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。","display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"description":"People attending or participating in the occurrence.","title":"Attendees","type":"person_list"},"description":{"description":"Optional details about the occurrence.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"location":{"description":"Where the occurrence happens, when explicitly provided.","nullable":true,"title":"Location","type":"location"},"status":{"description":"Current lifecycle state of the event.","required":true,"title":"Status","type":"enum","values":["active","cancelled"]},"summary":{"description":"A concise name for the calendar occurrence.","maxLength":100,"minLength":1,"required":true,"title":"Summary","type":"string"},"when":{"description":"When the occurrence happens. Use the date variant for all-day/date-only events and the instant variant for timed events.","required":true,"title":"When","type":"temporal_range"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","when","attendeePersonIds","location"],"searchable":["summary","description","location"],"sortable":["when","summary"]}}','7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6','breaking',
 'service','svc_lifespace_bootstrap','LifeSpace schema 74 Event Location cutover',
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (
  SELECT 1 FROM model_definitions
  WHERE model_key='event' AND state='superseded' AND schema_hash='be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a'
);

CREATE TABLE "mdl_event_location_v2" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "summary" TEXT NOT NULL,
  "description" TEXT,
  "__loc_location_name" TEXT CHECK("__loc_location_name" IS NULL OR length(trim("__loc_location_name")) BETWEEN 1 AND 500),
  "__loc_location_address" TEXT CHECK("__loc_location_address" IS NULL OR length(trim("__loc_location_address")) BETWEEN 1 AND 1000),
  "__loc_location_latitude" REAL CHECK("__loc_location_latitude" IS NULL OR "__loc_location_latitude" BETWEEN -90 AND 90),
  "__loc_location_longitude" REAL CHECK(("__loc_location_name" IS NULL AND "__loc_location_address" IS NULL AND "__loc_location_latitude" IS NULL AND "__loc_location_longitude" IS NULL) OR ("__loc_location_name" IS NOT NULL AND (("__loc_location_latitude" IS NULL AND "__loc_location_longitude" IS NULL) OR ("__loc_location_latitude" IS NOT NULL AND "__loc_location_longitude" IS NOT NULL)) AND "__loc_location_longitude" BETWEEN -180 AND 180)),
  "__tr_when_kind" TEXT NOT NULL CHECK("__tr_when_kind" IS NULL OR "__tr_when_kind" IN ('date','instant')),
  "__tr_when_start" TEXT NOT NULL,
  "__tr_when_end" TEXT NOT NULL CHECK(("__tr_when_kind" IS NULL AND "__tr_when_start" IS NULL AND "__tr_when_end" IS NULL) OR ("__tr_when_kind" IS NOT NULL AND "__tr_when_start" IS NOT NULL AND "__tr_when_end" IS NOT NULL AND "__tr_when_start" < "__tr_when_end")),
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('active','cancelled')),
  UNIQUE(space_id,record_id)
);

INSERT INTO "mdl_event_location_v2" (
 record_id,space_id,"summary","description",
 "__loc_location_name","__loc_location_address","__loc_location_latitude","__loc_location_longitude",
 "__tr_when_kind","__tr_when_start","__tr_when_end","status"
)
SELECT
 record_id,space_id,"summary","description",
 NULLIF(TRIM("location"),''),NULL,NULL,NULL,
 "__tr_when_kind","__tr_when_start","__tr_when_end","status"
FROM "mdl_event";

DROP TABLE "mdl_event";
ALTER TABLE "mdl_event_location_v2" RENAME TO "mdl_event";

CREATE INDEX "idx_mdl_event_location" ON "mdl_event"(space_id,"__loc_location_latitude","__loc_location_longitude",record_id);
CREATE INDEX "idx_mdl_event_status" ON "mdl_event"(space_id,"status",record_id);
CREATE INDEX "idx_mdl_event_summary" ON "mdl_event"(space_id,"summary",record_id);
CREATE INDEX "idx_mdl_event_when" ON "mdl_event"(space_id,"__tr_when_kind","__tr_when_start","__tr_when_end",record_id);

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='event' AND state='published')
WHERE model_key='event';

CREATE TABLE _schema74_postflight (
  published_event_count INTEGER NOT NULL CHECK(published_event_count=1),
  new_event_contract_count INTEGER NOT NULL CHECK(new_event_contract_count=1),
  record_count INTEGER NOT NULL,
  storage_count INTEGER NOT NULL,
  location_count INTEGER NOT NULL,
  migrated_name_count INTEGER NOT NULL,
  CHECK(record_count=storage_count),
  CHECK(location_count=migrated_name_count)
);
INSERT INTO _schema74_postflight(published_event_count,new_event_contract_count,record_count,storage_count,location_count,migrated_name_count)
SELECT
 (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published'),
 (SELECT COUNT(*) FROM model_definitions WHERE model_key='event' AND state='published' AND schema_hash='7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6'),
 (SELECT COUNT(*) FROM resource_records WHERE model_key='event'),
 (SELECT COUNT(*) FROM mdl_event),
 (SELECT COUNT(*) FROM mdl_event WHERE "__loc_location_name" IS NOT NULL),
 (SELECT COUNT(*) FROM mdl_event WHERE "__loc_location_name" IS NOT NULL AND "__loc_location_address" IS NULL AND "__loc_location_latitude" IS NULL AND "__loc_location_longitude" IS NULL);
DROP TABLE _schema74_postflight;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='74' WHERE key='schema_version';
