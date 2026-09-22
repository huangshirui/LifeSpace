-- #268: Backfill historical service principal audit name snapshots.
--
-- Current and future writes keep the stable svc_* principal id as identity,
-- while the human readable name is resolved from Identity and stored as an
-- audit presentation snapshot. This migration repairs rows created before
-- that behavior existed.
--
-- Do not change *_by_type or *_by_id. Those fields are the audit identity.
-- Only presentation snapshots are updated.

UPDATE resource_records
SET
  created_by_name_snapshot = COALESCE(
    (
      SELECT sp.display_name
      FROM service_principals sp
      WHERE sp.id = created_by_id
    ),
    created_by_name_snapshot
  ),
  updated_by_name_snapshot = COALESCE(
    (
      SELECT sp.display_name
      FROM service_principals sp
      WHERE sp.id = updated_by_id
    ),
    updated_by_name_snapshot
  )
WHERE created_by_type = 'service'
   OR updated_by_type = 'service';
