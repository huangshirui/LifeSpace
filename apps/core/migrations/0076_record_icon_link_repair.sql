-- Schema 76: restore missing Record Icon File links without altering Record data.
-- A business-only PATCH used to delete all File projections, inadvertently
-- detaching presentation.icon image Files while leaving icon_json unchanged.
--
-- Apply after shipping the generic-resource.ts fix as a coordinated release:
-- migrations normally run before the new Worker, so pause mutable consumers or
-- minimize the interval where an old Worker could detach a repaired link again.
-- All repairs are within the same Space/Model and never fabricate File identities.
-- D1 cannot verify R2 bytes; separately audit files.object_key when a 404 remains.

-- D1's numbered migration ledger governs ordering. Do not add an extra exact-
-- version preflight: the test migration runner initializes its databases with
-- compatible histories that need not expose an intermediate schema version here.
-- Referenced tables/columns and the INSERT trigger remain hard validity gates.

-- Fail closed on missing/mismatched provenance, deleted Records/Files, conflicting
-- attachments, and malformed/incompatible File metadata. Preserve all existing
-- links. The insert guard independently verifies Record/Space/File integrity.
INSERT INTO resource_file_links(
  source_record_id, source_space_id, source_model_key, field_key, ordinal, file_id
)
SELECT r.id, r.space_id, r.model_key, '__record_icon', 0,
  json_extract(r.icon_json, '$.fileId')
FROM resource_records r
JOIN files f ON f.id=json_extract(r.icon_json, '$.fileId')
WHERE r.deleted_at IS NULL
  AND r.icon_json IS NOT NULL
  AND json_extract(r.icon_json, '$.type')='image'
  AND f.space_id=r.space_id
  AND f.status='ready'
  AND f.content_type IN ('image/png','image/jpeg','image/webp')
  AND f.size_bytes BETWEEN 1 AND 262144
  AND EXISTS (
    SELECT 1 FROM file_upload_sessions s
    WHERE s.file_id=f.id
      AND s.space_id=r.space_id
      AND s.model_key=r.model_key
      AND s.field_key='__record_icon'
      AND s.destination='native'
      AND s.status='completed'
      AND (s.record_id IS NULL OR s.record_id=r.id)
      AND s.application_id=f.application_id
      AND s.principal_type=f.principal_type
      AND s.principal_id=f.principal_id
      AND s.content_type=f.content_type
      AND s.expected_size=f.size_bytes
  )
  AND NOT EXISTS (
    SELECT 1 FROM resource_file_links l
    WHERE l.source_record_id=r.id AND l.field_key='__record_icon'
  )
  AND NOT EXISTS (
    SELECT 1 FROM resource_file_links l WHERE l.file_id=f.id
  );

UPDATE schema_metadata SET value='76' WHERE key='schema_version';
