-- PBD Person foundation: Space Person remains Kernel state while gaining
-- optimistic concurrency, alternate-name search and durable governed-change evidence.
-- display_name remains the canonical label projected by reference lookup/resolution.

ALTER TABLE space_people
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);

-- Membership/Space lifecycle code predates Person optimistic concurrency. When those
-- existing Kernel paths reactivate/deactivate/rename a linked Person without explicitly
-- touching version, advance it in the same D1 statement. Person Directory writes set
-- version themselves, so the WHEN clause prevents a second increment.
CREATE TRIGGER trg_space_people_advance_version
AFTER UPDATE OF display_name,linked_user_id,deleted_at ON space_people
WHEN NEW.version=OLD.version
  AND (
    NEW.display_name IS NOT OLD.display_name
    OR NEW.linked_user_id IS NOT OLD.linked_user_id
    OR NEW.deleted_at IS NOT OLD.deleted_at
  )
BEGIN
  UPDATE space_people SET version=version+1 WHERE id=NEW.id;
END;

-- Space Person IDs are globally unique already; this composite key exists so child
-- Kernel state can enforce that its denormalized space_id matches the referenced Person.
CREATE UNIQUE INDEX uq_space_people_space_person
  ON space_people(space_id, id);

CREATE INDEX idx_space_people_lookup
  ON space_people(space_id, display_name COLLATE NOCASE, id)
  WHERE deleted_at IS NULL;

CREATE TABLE space_person_names (
  id TEXT PRIMARY KEY CHECK(id GLOB 'spn_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  person_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(space_id, person_id) REFERENCES space_people(space_id, id)
);

-- One normalized/case-insensitive spelling has one durable row per Person. A removed
-- alternate name is soft-deleted and may later be reactivated without accumulating
-- duplicate historical rows.
CREATE UNIQUE INDEX uq_space_person_name
  ON space_person_names(space_id, person_id, name COLLATE NOCASE);

CREATE INDEX idx_space_person_names_lookup
  ON space_person_names(space_id, name COLLATE NOCASE, person_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_space_person_names_person
  ON space_person_names(space_id, person_id, deleted_at, name COLLATE NOCASE);

-- Person changes are Kernel governed-change evidence. They also provide the atomic
-- exercise point for single-use Delegations on non-model Person Directory writes.
CREATE TABLE space_person_changes (
  id TEXT PRIMARY KEY CHECK(id GLOB 'pchg_*'),
  person_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
  version_before INTEGER,
  version_after INTEGER NOT NULL CHECK(version_after >= 1),
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  delegation_id TEXT REFERENCES delegations(id),
  changed_fields_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_fields_json)),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(space_id, person_id) REFERENCES space_people(space_id, id),
  CHECK(
    (operation='create' AND version_before IS NULL AND version_after=1)
    OR
    (operation IN ('update','delete') AND version_before IS NOT NULL AND version_after=version_before+1)
  )
);

CREATE INDEX idx_space_person_changes_person
  ON space_person_changes(space_id, person_id, version_after DESC, occurred_at DESC);
CREATE INDEX idx_space_person_changes_actor
  ON space_person_changes(actor_type, actor_id, occurred_at DESC);
CREATE INDEX idx_space_person_changes_delegation
  ON space_person_changes(delegation_id, occurred_at DESC)
  WHERE delegation_id IS NOT NULL;

-- Validate update/delete preconditions while the mutation batch owns one D1 transaction.
-- This closes the race between a preflight read and the actual Person write.
CREATE TRIGGER trg_space_person_change_validate
BEFORE INSERT ON space_person_changes
BEGIN
  SELECT (CASE
    WHEN NEW.operation='create' AND NOT EXISTS(
      SELECT 1 FROM space_people p
      WHERE p.id=NEW.person_id AND p.space_id=NEW.space_id
        AND p.deleted_at IS NULL AND p.version=1
    )
    THEN RAISE(ABORT, 'PERSON_CREATE_STATE_INVALID')
  END);

  SELECT (CASE
    WHEN NEW.operation IN ('update','delete') AND NOT EXISTS(
      SELECT 1 FROM space_people p
      WHERE p.id=NEW.person_id AND p.space_id=NEW.space_id
        AND p.deleted_at IS NULL AND p.version=NEW.version_before
    )
    THEN RAISE(ABORT, 'PERSON_VERSION_CONFLICT')
  END);

  SELECT (CASE
    WHEN NEW.operation='delete' AND EXISTS(
      SELECT 1 FROM space_people p
      WHERE p.id=NEW.person_id AND p.space_id=NEW.space_id
        AND p.linked_user_id IS NOT NULL AND p.deleted_at IS NULL
    )
    THEN RAISE(ABORT, 'PERSON_LINKED_USER')
  END);

  SELECT (CASE
    WHEN NEW.operation='delete' AND EXISTS(
      SELECT 1
      FROM resource_relations rr
      JOIN resource_records r ON r.id=rr.source_record_id
      WHERE rr.target_type='person'
        AND rr.target_person_id=NEW.person_id
        AND rr.source_space_id=NEW.space_id
        AND r.deleted_at IS NULL
    )
    THEN RAISE(ABORT, 'PERSON_IN_USE')
  END);
END;

-- Durable evidence of the exact Delegation chain used by a committed Person change.
-- chain_position=0 is the root and the highest position is the request leaf.
CREATE TABLE space_person_change_delegations (
  change_id TEXT NOT NULL REFERENCES space_person_changes(id) ON DELETE CASCADE,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  chain_position INTEGER NOT NULL CHECK(chain_position BETWEEN 0 AND 3),
  PRIMARY KEY(change_id, chain_position),
  UNIQUE(change_id, delegation_id)
);

CREATE INDEX idx_space_person_change_delegations_delegation
  ON space_person_change_delegations(delegation_id, change_id);

CREATE TRIGGER trg_space_person_change_delegation_consume_single_use
BEFORE INSERT ON space_person_change_delegations
WHEN EXISTS(
  SELECT 1 FROM delegations
  WHERE id=NEW.delegation_id AND max_uses=1
)
BEGIN
  UPDATE delegations
  SET consumed_at=(
        SELECT occurred_at FROM space_person_changes WHERE id=NEW.change_id
      ),
      consumed_by_change_id=NEW.change_id
  WHERE id=NEW.delegation_id
    AND max_uses=1
    AND consumed_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'));

  SELECT (CASE
    WHEN NOT EXISTS(
      SELECT 1
      FROM delegations
      WHERE id=NEW.delegation_id
        AND max_uses=1
        AND consumed_by_change_id=NEW.change_id
    )
    THEN RAISE(ABORT, 'DELEGATION_SINGLE_USE_UNAVAILABLE')
  END);
END;

UPDATE schema_metadata SET value='51' WHERE key='schema_version';
