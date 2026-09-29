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

CREATE TABLE delegations (
  id TEXT PRIMARY KEY CHECK(id GLOB 'dlg_*'),
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1),
  consumed_at TEXT,
  consumed_by_change_id TEXT,
  CHECK(consumed_at IS NULL OR max_uses=1)
);

CREATE TABLE delegation_scopes (
  delegation_id TEXT PRIMARY KEY REFERENCES delegations(id),
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

INSERT INTO delegations(
  id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
  created_by_type,created_by_id,created_at,expires_at,revoked_at,max_uses,consumed_at,consumed_by_change_id
)
SELECT
  map.new_delegation_id,
  'user',
  d.principal_user_id,
  'agent',
  d.agent_id,
  d.application_id,
  d.source_space_id,
  'user',
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
INSERT INTO delegations(
  id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
  created_by_type,created_by_id,created_at,expires_at,revoked_at,max_uses,consumed_at,consumed_by_change_id
)
SELECT
  d.id,
  'user',
  d.principal_user_id,
  'agent',
  d.agent_id,
  d.application_id,
  d.source_space_id,
  'user',
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

INSERT INTO delegation_scopes(
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

CREATE INDEX idx_delegations_authority
  ON delegations(
    principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
    revoked_at,consumed_at,expires_at
  );
CREATE INDEX idx_delegations_space_principal
  ON delegations(
    source_space_id,principal_type,principal_id,application_id,created_at DESC
  );
CREATE INDEX idx_delegation_scopes_target
  ON delegation_scopes(
    target_type,target_id,target_model_key,max_access,delegation_id
  );

DROP TABLE _migration_0047_delegation_scope_map;
DROP TABLE _migration_0047_agent_delegation_models;
DROP TABLE _migration_0047_agent_delegations;

-- Wish ownership policy is Principal-relative. A represented Agent remains
-- the Actor and therefore has no Space Person unless explicitly modeled as one.
-- The Principal user's Space Person is the business identity compared with
-- ownerPersonId. This is a compatible semantic publication: wire/storage shape
-- is unchanged while delegated execution stops conflating Actor with Principal.
UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published'
  AND schema_hash='7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_wish_principal_person_20260929','wish','wish',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='wish'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"fulfill":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be fulfilled","op":"eq","value":"open"}],"policy":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":{"$ref":"now"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_NOT_FULFILLED","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"description":"An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。","display":{"plural":"Wishes","singular":"Wish"},"fields":{"description":{"description":"Optional detail about the aspiration and why it is desired.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"desiredDate":{"description":"A hoped-for date, not a committed task deadline or scheduled event time.","nullable":true,"title":"Desired Date","type":"date"},"fulfilledAt":{"description":"When the wish was marked fulfilled.","nullable":true,"readOnly":true,"title":"Fulfilled At","type":"datetime"},"ownerPersonId":{"description":"The person whose aspiration this is.","immutable":true,"required":true,"title":"Owner","type":"person"},"status":{"description":"Whether the wish is still waiting to happen or has been fulfilled.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["open","fulfilled"]},"title":{"description":"A concise statement of the aspiration or desired outcome.","maxLength":100,"minLength":1,"required":true,"title":"Title","type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}},"read":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"update":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}}},"query":{"filterable":["status","ownerPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]}}',
  '772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934',
  'compatible',
  'service','svc_lifespace_bootstrap','LifeSpace schema 47 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='wish' AND state='published'
    AND schema_hash='772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934'
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
    SELECT 1 FROM delegations
    WHERE id=NEW.delegation_id AND max_uses=1
  )
BEGIN
  UPDATE delegations
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
      FROM delegations
      WHERE id=NEW.delegation_id
        AND max_uses=1
        AND consumed_by_change_id=NEW.id
    )
    THEN RAISE(ABORT, 'DELEGATION_SINGLE_USE_UNAVAILABLE')
  END;
END;

UPDATE schema_metadata SET value='47' WHERE key='schema_version';

PRAGMA foreign_keys = ON;
