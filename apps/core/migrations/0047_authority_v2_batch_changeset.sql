PRAGMA foreign_keys = OFF;

-- #295 is an intentional breaking authority cutover.
--
-- The pre-Authority-v2 User -> Agent Delegation representation is not migrated
-- or kept compatible. Existing delegated authorization is invalidated and must
-- be explicitly re-issued under the one-Delegation/one-Scope model.
--
-- Historical Change rows keep Principal / Actor / Application evidence but drop
-- references to retired Delegation rows.
UPDATE resource_changes
SET delegation_id=NULL
WHERE delegation_id IS NOT NULL;

DROP TABLE IF EXISTS agent_delegation_models;
DROP TABLE IF EXISTS agent_delegations;

CREATE TABLE agent_delegations (
  id TEXT PRIMARY KEY CHECK(id GLOB 'dlg_*'),
  principal_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK(agent_id LIKE 'agt_%'),
  application_id TEXT NOT NULL,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1),
  consumed_at TEXT,
  consumed_by_change_id TEXT,
  CHECK(consumed_at IS NULL OR max_uses=1)
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

CREATE INDEX idx_agent_delegations_authority
  ON agent_delegations(
    principal_user_id,agent_id,application_id,source_space_id,
    revoked_at,consumed_at,expires_at
  );
CREATE INDEX idx_agent_delegations_space_user
  ON agent_delegations(
    source_space_id,principal_user_id,application_id,created_at DESC
  );
CREATE INDEX idx_agent_delegation_scopes_target
  ON agent_delegation_scopes(
    target_type,target_id,target_model_key,max_access,delegation_id
  );

-- The former generic Resource Provenance envelope is retired without migration.
-- Provenance is no longer a special Runtime envelope/storage plane. Future
-- provenance is modeled through ordinary business relations/semantic roles.
DROP TABLE IF EXISTS resource_provenance;

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
  occurred_at TEXT NOT NULL,
  committed_at TEXT
);

ALTER TABLE resource_changes
  ADD COLUMN change_set_id TEXT CHECK(change_set_id IS NULL OR change_set_id GLOB 'cgs_*');
CREATE INDEX idx_resource_changes_change_set
  ON resource_changes(change_set_id,occurred_at,id) WHERE change_set_id IS NOT NULL;

-- Finalizing an explicit Batch is the transaction completeness gate. Each
-- successful item must have inserted exactly one governed Change. If an
-- optimistic-concurrency predicate or another guarded item mutation matched
-- zero rows, this trigger aborts the entire D1 batch rather than allowing a
-- partial ChangeSet to commit.
CREATE TRIGGER trg_resource_change_set_require_complete
BEFORE UPDATE OF committed_at ON resource_change_sets
WHEN NEW.committed_at IS NOT NULL AND OLD.committed_at IS NULL
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM resource_changes c
      WHERE c.change_set_id=NEW.id
    ) <> NEW.operation_count
    THEN RAISE(ABORT, 'CHANGE_SET_INCOMPLETE')
  END;
END;

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
