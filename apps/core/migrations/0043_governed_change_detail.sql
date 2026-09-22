-- #209: bind governed Change to exact mutation detail and Eventing references.
--
-- New rows persist exact field-level before/after evidence and semantic action identity.
-- Historical resource_changes remain explicitly partial: field_changes_json/action_key stay NULL.
-- Eventing remains reference-only; domain_event_outbox carries only the opaque change_id link.

ALTER TABLE resource_changes ADD COLUMN action_key TEXT;
ALTER TABLE resource_changes ADD COLUMN field_changes_json TEXT;

ALTER TABLE domain_event_outbox
  ADD COLUMN change_id TEXT CHECK(change_id IS NULL OR change_id GLOB 'chg_*');

CREATE INDEX idx_domain_event_outbox_change
  ON domain_event_outbox(change_id) WHERE change_id IS NOT NULL;

-- Best-effort historical linkage is safe where the already-authoritative
-- record/version tuple identifies the existing Change. Events older than
-- resource_changes intentionally remain NULL rather than fabricating evidence.
UPDATE domain_event_outbox
SET change_id=(
  SELECT c.id
  FROM resource_changes c
  WHERE c.record_id=domain_event_outbox.record_id
    AND c.space_id=domain_event_outbox.space_id
    AND c.model_key=domain_event_outbox.model_key
    AND c.version_after=domain_event_outbox.record_version
  ORDER BY c.occurred_at DESC,c.id DESC
  LIMIT 1
)
WHERE change_id IS NULL
  AND EXISTS(
    SELECT 1
    FROM resource_changes c
    WHERE c.record_id=domain_event_outbox.record_id
      AND c.space_id=domain_event_outbox.space_id
      AND c.model_key=domain_event_outbox.model_key
      AND c.version_after=domain_event_outbox.record_version
  );

-- Generic Runtime now uses the chg_* id as the transient mutation token.
-- The trigger observes that token inside the same D1 transaction and writes
-- the opaque Change reference before the token is cleared.
DROP TRIGGER trg_domain_event_resource_created;
DROP TRIGGER trg_domain_event_resource_updated;
DROP TRIGGER trg_domain_event_resource_deleted;

CREATE TRIGGER trg_domain_event_resource_created
AFTER INSERT ON resource_records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.created',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    NEW.created_by_type,
    NEW.created_by_id,
    NEW.created_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_updated
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.updated',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    NEW.updated_by_type,
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_deleted
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.deleted',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    NEW.updated_by_type,
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

UPDATE schema_metadata SET value='43' WHERE key='schema_version';
