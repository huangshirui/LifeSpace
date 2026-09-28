PRAGMA foreign_keys = OFF;

-- #295 is an intentional breaking authority cutover for executable
-- Delegations. Pre-v2 Delegations are never left active after migration and
-- callers must explicitly re-issue authority under the one-Delegation/one-Scope
-- model.
--
-- Historical Change attribution is different from runtime compatibility:
-- resource_changes.delegation_id is durable audit evidence and must not be
-- erased. Preserve old rows as revoked historical Delegations. A legacy
-- multi-model Delegation is deterministically split; the original dlg_* ID
-- represents its lexicographically first model and sibling IDs represent the
-- remaining models. Existing Change rows are remapped by their model_key.
CREATE TABLE _migration_0047_agent_delegations AS
SELECT * FROM agent_delegations;

CREATE TABLE _migration_0047_agent_delegation_models AS
SELECT * FROM agent_delegation_models;

DROP TABLE agent_delegation_models;
DROP TABLE agent_delegations;

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

CREATE TABLE _migration_0047_delegation_scope_map (
  old_delegation_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  new_delegation_id TEXT NOT NULL,
  PRIMARY KEY(old_delegation_id,model_key)
);

INSERT INTO _migration_0047_delegation_scope_map(
  old_delegation_id,model_key,new_delegation_id
)
SELECT
  m.delegation_id,
  m.model_key,
  CASE
    WHEN m.model_key=(
      SELECT MIN(m2.model_key)
      FROM _migration_0047_agent_delegation_models m2
      WHERE m2.delegation_id=m.delegation_id
    )
      THEN m.delegation_id
    ELSE m.delegation_id || '_legacy_' || lower(hex(m.model_key))
  END
FROM _migration_0047_agent_delegation_models m;

INSERT INTO agent_delegations(
  id,principal_user_id,agent_id,application_id,source_space_id,
  created_by_user_id,created_at,expires_at,revoked_at,max_uses,consumed_at,consumed_by_change_id
)
SELECT
  map.new_delegation_id,
  d.principal_user_id,
  d.agent_id,
  d.application_id,
  d.source_space_id,
  d.created_by_user_id,
  d.created_at,
  d.expires_at,
  COALESCE(d.revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  NULL,
  NULL,
  NULL
FROM _migration_0047_delegation_scope_map map
JOIN _migration_0047_agent_delegations d ON d.id=map.old_delegation_id;

-- Defensive audit preservation for an impossible-but-legal legacy row that had
-- no model scope. It remains revoked and has no executable v2 scope.
INSERT INTO agent_delegations(
  id,principal_user_id,agent_id,application_id,source_space_id,
  created_by_user_id,created_at,expires_at,revoked_at,max_uses,consumed_at,consumed_by_change_id
)
SELECT
  d.id,
  d.principal_user_id,
  d.agent_id,
  d.application_id,
  d.source_space_id,
  d.created_by_user_id,
  d.created_at,
  d.expires_at,
  COALESCE(d.revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  NULL,
  NULL,
  NULL
FROM _migration_0047_agent_delegations d
WHERE NOT EXISTS(
  SELECT 1
  FROM _migration_0047_delegation_scope_map map
  WHERE map.old_delegation_id=d.id
);

INSERT INTO agent_delegation_scopes(
  delegation_id,target_type,target_id,target_model_key,max_access
)
SELECT
  map.new_delegation_id,
  'model',
  map.model_key,
  map.model_key,
  m.max_access
FROM _migration_0047_delegation_scope_map map
JOIN _migration_0047_agent_delegation_models m
  ON m.delegation_id=map.old_delegation_id
 AND m.model_key=map.model_key;

UPDATE resource_changes
SET delegation_id=(
  SELECT map.new_delegation_id
  FROM _migration_0047_delegation_scope_map map
  WHERE map.old_delegation_id=resource_changes.delegation_id
    AND map.model_key=resource_changes.model_key
)
WHERE delegation_id IS NOT NULL
  AND EXISTS(
    SELECT 1
    FROM _migration_0047_delegation_scope_map map
    WHERE map.old_delegation_id=resource_changes.delegation_id
      AND map.model_key=resource_changes.model_key
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

DROP TABLE _migration_0047_delegation_scope_map;
DROP TABLE _migration_0047_agent_delegation_models;
DROP TABLE _migration_0047_agent_delegations;

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
