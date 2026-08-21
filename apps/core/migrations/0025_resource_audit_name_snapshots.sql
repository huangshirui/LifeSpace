-- Generic Resource audit actors are part of the durable common record envelope.
-- Earlier Generic Runtime writes stored the principal id in *_by_name_snapshot.
-- Backfill user snapshots from the Space Person history and keep future writes
-- correct without adding another Worker -> D1 round trip to mutation paths.

UPDATE resource_records
SET created_by_name_snapshot = COALESCE(
  (
    SELECT p.display_name
    FROM space_people p
    WHERE p.space_id = resource_records.space_id
      AND p.linked_user_id = resource_records.created_by_id
    ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
    LIMIT 1
  ),
  created_by_name_snapshot
)
WHERE created_by_type = 'user'
  AND created_by_name_snapshot = created_by_id;

UPDATE resource_records
SET updated_by_name_snapshot = COALESCE(
  (
    SELECT p.display_name
    FROM space_people p
    WHERE p.space_id = resource_records.space_id
      AND p.linked_user_id = resource_records.updated_by_id
    ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
    LIMIT 1
  ),
  updated_by_name_snapshot
)
WHERE updated_by_type = 'user'
  AND updated_by_name_snapshot = updated_by_id;

CREATE TRIGGER trg_resource_records_insert_actor_names
AFTER INSERT ON resource_records
WHEN
  (NEW.created_by_type = 'user' AND NEW.created_by_name_snapshot = NEW.created_by_id)
  OR
  (NEW.updated_by_type = 'user' AND NEW.updated_by_name_snapshot = NEW.updated_by_id)
BEGIN
  UPDATE resource_records
  SET
    created_by_name_snapshot = CASE
      WHEN NEW.created_by_type = 'user' AND NEW.created_by_name_snapshot = NEW.created_by_id
      THEN COALESCE(
        (
          SELECT p.display_name
          FROM space_people p
          WHERE p.space_id = NEW.space_id
            AND p.linked_user_id = NEW.created_by_id
          ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
          LIMIT 1
        ),
        NEW.created_by_name_snapshot
      )
      ELSE NEW.created_by_name_snapshot
    END,
    updated_by_name_snapshot = CASE
      WHEN NEW.updated_by_type = 'user' AND NEW.updated_by_name_snapshot = NEW.updated_by_id
      THEN COALESCE(
        (
          SELECT p.display_name
          FROM space_people p
          WHERE p.space_id = NEW.space_id
            AND p.linked_user_id = NEW.updated_by_id
          ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
          LIMIT 1
        ),
        NEW.updated_by_name_snapshot
      )
      ELSE NEW.updated_by_name_snapshot
    END
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_resource_records_update_actor_name
AFTER UPDATE OF updated_by_type, updated_by_id, updated_by_name_snapshot ON resource_records
WHEN NEW.updated_by_type = 'user' AND NEW.updated_by_name_snapshot = NEW.updated_by_id
BEGIN
  UPDATE resource_records
  SET updated_by_name_snapshot = COALESCE(
    (
      SELECT p.display_name
      FROM space_people p
      WHERE p.space_id = NEW.space_id
        AND p.linked_user_id = NEW.updated_by_id
      ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
      LIMIT 1
    ),
    NEW.updated_by_name_snapshot
  )
  WHERE id = NEW.id;
END;

UPDATE schema_metadata
SET value='25'
WHERE key='schema_version';
