PRAGMA foreign_keys = ON;

-- Delegation is current-state Authority: a user allows one Agent, in one application
-- context, to exercise no more than the listed model access inside one Space.
CREATE TABLE agent_delegations (
  id TEXT PRIMARY KEY,
  principal_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK(agent_id LIKE 'agt_%'),
  application_id TEXT NOT NULL,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE agent_delegation_models (
  delegation_id TEXT NOT NULL REFERENCES agent_delegations(id),
  model_key TEXT NOT NULL,
  max_access TEXT NOT NULL CHECK(max_access IN ('read','write','manage')),
  PRIMARY KEY(delegation_id, model_key)
);

CREATE INDEX idx_agent_delegations_authority
  ON agent_delegations(principal_user_id, agent_id, application_id, source_space_id, revoked_at, expires_at);
CREATE INDEX idx_agent_delegations_space_user
  ON agent_delegations(source_space_id, principal_user_id, revoked_at, created_at DESC);
CREATE INDEX idx_agent_delegation_models_model
  ON agent_delegation_models(model_key, max_access, delegation_id);

-- Lightweight, append-only evidence for committed Shared Reality changes.
-- This is not a proposal/workflow engine; ordinary CRUD and semantic Actions remain
-- the simple execution form of Change.
CREATE TABLE resource_changes (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES resource_records(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  model_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','action','delete')),
  version_before INTEGER,
  version_after INTEGER NOT NULL CHECK(version_after >= 1),
  principal_type TEXT NOT NULL CHECK(principal_type IN ('user','service','device')),
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','service','device','agent')),
  actor_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  delegation_id TEXT REFERENCES agent_delegations(id),
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_resource_changes_record
  ON resource_changes(record_id, version_after DESC, occurred_at DESC);
CREATE INDEX idx_resource_changes_space_time
  ON resource_changes(space_id, occurred_at DESC, id DESC);
CREATE INDEX idx_resource_changes_actor
  ON resource_changes(actor_type, actor_id, occurred_at DESC);
CREATE INDEX idx_resource_changes_delegation
  ON resource_changes(delegation_id, occurred_at DESC) WHERE delegation_id IS NOT NULL;

UPDATE schema_metadata SET value='32' WHERE key='schema_version';
