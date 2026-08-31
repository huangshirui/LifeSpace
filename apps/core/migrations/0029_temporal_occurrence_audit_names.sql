-- Temporal occurrence audit actors are Capability-owned child records, but they
-- must preserve the same immutable user display-name snapshot semantics as the
-- common Generic Resource audit envelope.
--
-- Earlier Temporal writes stored principal.id in recorded_by_name_snapshot.
-- Backfill user snapshots from Space Person history and keep future inserts
-- correct inside D1 without adding another Worker -> D1 round trip.

UPDATE temporal_occurrences
SET recorded_by_name_snapshot = COALESCE(
  (
    SELECT p.display_name
    FROM resource_records r
    JOIN space_people p
      ON p.space_id = r.space_id
      AND p.linked_user_id = temporal_occurrences.recorded_by_id
    WHERE r.id = temporal_occurrences.record_id
    ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
    LIMIT 1
  ),
  recorded_by_name_snapshot
)
WHERE recorded_by_type = 'user'
  AND recorded_by_name_snapshot = recorded_by_id;

CREATE TRIGGER trg_temporal_occurrences_insert_actor_name
AFTER INSERT ON temporal_occurrences
WHEN NEW.recorded_by_type = 'user'
  AND NEW.recorded_by_name_snapshot = NEW.recorded_by_id
BEGIN
  UPDATE temporal_occurrences
  SET recorded_by_name_snapshot = COALESCE(
    (
      SELECT p.display_name
      FROM resource_records r
      JOIN space_people p
        ON p.space_id = r.space_id
        AND p.linked_user_id = NEW.recorded_by_id
      WHERE r.id = NEW.record_id
      ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
      LIMIT 1
    ),
    NEW.recorded_by_name_snapshot
  )
  WHERE id = NEW.id;
END;

UPDATE schema_metadata
SET value='29'
WHERE key='schema_version';
