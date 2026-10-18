-- External record IDs are globally addressed. A Provider/Adapter may never make an
-- existing ID refer to a different Space or External binding. The previous UPSERT
-- deliberately constrained its UPDATE but silently ignored conflicting ownership;
-- reject that identity substitution at the D1 commit boundary instead.
-- This also protects deferred External Relation endpoint observation finalizers.
CREATE TRIGGER trg_external_record_identity_ownership
BEFORE INSERT ON external_record_identities
WHEN EXISTS (
  SELECT 1 FROM external_record_identities existing
  WHERE existing.record_id=NEW.record_id
    AND (existing.model_key<>NEW.model_key OR existing.space_id<>NEW.space_id)
)
BEGIN
  SELECT RAISE(ABORT, 'EXTERNAL_RECORD_ID_COLLISION');
END;

UPDATE schema_metadata SET value='68' WHERE key='schema_version';
