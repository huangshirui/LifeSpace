PRAGMA foreign_keys = OFF;

-- #295: converge Delegation to one immutable scope per row and introduce the
-- minimum durable primitives required for single-use execution and atomic
-- first-class Batch ChangeSets.
--
-- Historical User -> Agent delegations may contain more than one model scope
-- through agent_delegation_models. Preserve the original dlg_* id for the
-- lexicographically first model and split every additional model into a
-- deterministic sibling Delegation. Historical resource_changes references are
-- rewritten to the sibling that represents the model actually changed.

ALTER TABLE agent_delegations ADD COLUMN max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1);
ALTER TABLE agent_delegations ADD COLUMN consumed_at TEXT;
ALTER TABLE agent_delegations ADD COLUMN consumed_by_change_id TEXT;

INSERT INTO agent_delegations(
  id,principal_user_id,agent_id,application_id,source_space_id,
  created_by_user_id,created_at,expires_at,revoked_at,max_uses,consumed_at,consumed_by_change_id
)
SELECT
  d.id || '_split_' || lower(hex(m.model_key)),
  d.principal_user_id,
  d.agent_id,
  d.application_id,
  d.source_space_id,
  d.created_by_user_id,
  d.created_at,
  d.expires_at,
  d.revoked_at,
  NULL,
  NULL,
  NULL
FROM agent_delegations d
JOIN agent_delegation_models m ON m.delegation_id=d.id
WHERE m.model_key <> (
  SELECT MIN(m2.model_key)
  FROM agent_delegation_models m2
  WHERE m2.delegation_id=d.id
);

UPDATE resource_changes
SET delegation_id = delegation_id || '_split_' || lower(hex(model_key))
WHERE delegation_id IS NOT NULL
  AND EXISTS(
    SELECT 1
    FROM agent_delegation_models m
    WHERE m.delegation_id=resource_changes.delegation_id
      AND m.model_key=resource_changes.model_key
      AND m.model_key <> (
        SELECT MIN(m2.model_key)
        FROM agent_delegation_models m2
        WHERE m2.delegation_id=m.delegation_id
      )
  );

CREATE TABLE agent_delegation_scopes (
  delegation_id TEXT PRIMARY KEY REFERENCES agent_delegations(id),
  target_type TEXT NOT NULL CHECK(target_type IN ('space','model','record')),
  target_id TEXT NOT NULL,
  target_model_key TEXT,
  max_access TEXT NOT NULL CHECK(max_access IN ('free_busy','read','write','manage')),
  CHECK(
    (target_type='space' AND target_model_key IS NULL)
    OR (target_type='model' AND target_model_key=target_id)
    OR (target_type='record' AND target_model_key IS NOT NULL)
  )
);

INSERT INTO agent_delegation_scopes(
  delegation_id,target_type,target_id,target_model_key,max_access
)
SELECT
  CASE
    WHEN m.model_key=(
      SELECT MIN(m2.model_key)
      FROM agent_delegation_models m2
      WHERE m2.delegation_id=m.delegation_id
    )
      THEN m.delegation_id
    ELSE m.delegation_id || '_split_' || lower(hex(m.model_key))
  END,
  'model',
  m.model_key,
  m.model_key,
  m.max_access
FROM agent_delegation_models m;

DROP TABLE agent_delegation_models;

CREATE INDEX idx_agent_delegation_scopes_target
  ON agent_delegation_scopes(target_type,target_id,target_model_key,max_access,delegation_id);

-- One explicit atomic Batch is one ChangeSet. Ordinary single CRUD keeps
-- change_set_id NULL. Change rows remain the per-resource source of truth.
CREATE TABLE resource_change_sets (
  id TEXT PRIMARY KEY CHECK(id GLOB 'cgs_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service','device')),
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','service','device','agent')),
  actor_id TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 20),
  occurred_at TEXT NOT NULL
);

ALTER TABLE resource_changes
  ADD COLUMN change_set_id TEXT CHECK(change_set_id IS NULL OR change_set_id GLOB 'cgs_*');
CREATE INDEX idx_resource_changes_change_set
  ON resource_changes(change_set_id,occurred_at,id) WHERE change_set_id IS NOT NULL;

ALTER TABLE domain_event_outbox
  ADD COLUMN change_set_id TEXT CHECK(change_set_id IS NULL OR change_set_id GLOB 'cgs_*');
CREATE INDEX idx_domain_event_outbox_change_set
  ON domain_event_outbox(change_set_id,occurred_at,id) WHERE change_set_id IS NOT NULL;

-- A single-use Delegation is consumed by the committed Change itself. Because
-- resource_changes is inserted inside the same D1 mutation batch as the business
-- write, RAISE(ABORT) rolls back both the business mutation and consumption when
-- another request already won, the Delegation was revoked/expired, or the same
-- single-use Delegation is attempted twice in one Batch.
CREATE TRIGGER trg_resource_change_consume_single_use_delegation
BEFORE INSERT ON resource_changes
WHEN NEW.delegation_id IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM agent_delegations
    WHERE id=NEW.delegation_id AND max_uses=1
  )
BEGIN
  UPDATE agent_delegations
  SET consumed_at=NEW.occurred_at,
      consumed_by_change_id=NEW.id
  WHERE id=NEW.delegation_id
    AND max_uses=1
    AND consumed_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'));

  SELECT CASE
    WHEN NOT EXISTS(
      SELECT 1
      FROM agent_delegations
      WHERE id=NEW.delegation_id
        AND max_uses=1
        AND consumed_by_change_id=NEW.id
    )
    THEN RAISE(ABORT, 'DELEGATION_SINGLE_USE_UNAVAILABLE')
  END;
END;

UPDATE schema_metadata SET value='47' WHERE key='schema_version';

PRAGMA foreign_keys = ON;
