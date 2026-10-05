-- #306: durable Authorization Request protocol for Agent-mediated user confirmation.
--
-- Requested Authority is immutable. Terminal state is represented by exactly one
-- transition row, which also acts as the concurrency lock for approve/deny/cancel.
-- Expiry is derived from expires_at while no terminal transition exists.

CREATE TABLE authorization_requests (
  id TEXT PRIMARY KEY CHECK(id GLOB 'arq_*'),
  application_id TEXT NOT NULL,
  requesting_agent_id TEXT NOT NULL CHECK(requesting_agent_id GLOB 'agt_*'),
  intended_user_id TEXT NOT NULL CHECK(intended_user_id GLOB 'usr_*'),
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  request_ttl_minutes INTEGER NOT NULL CHECK(request_ttl_minutes BETWEEN 1 AND 1440),
  fingerprint TEXT NOT NULL,
  reuse_key TEXT NOT NULL,
  correlation_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_authorization_requests_pending_reuse
  ON authorization_requests(
    application_id,requesting_agent_id,intended_user_id,source_space_id,fingerprint,expires_at
  );

CREATE TABLE authorization_request_reuse_keys (
  reuse_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES authorization_requests(id) ON DELETE CASCADE
);

CREATE TABLE authorization_request_items (
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),
  target_type TEXT NOT NULL CHECK(target_type IN ('space','model','record')),
  target_id TEXT NOT NULL,
  max_access TEXT NOT NULL CHECK(max_access IN ('free_busy','read','write','manage')),
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1),
  delegation_expires_at TEXT,
  remaining_redelegation_depth INTEGER NOT NULL DEFAULT 0
    CHECK(remaining_redelegation_depth BETWEEN 0 AND 3),
  PRIMARY KEY(request_id,ordinal)
);

CREATE TABLE authorization_request_transitions (
  request_id TEXT PRIMARY KEY REFERENCES authorization_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('approved','denied','cancelled')),
  transitioned_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL
);

CREATE TRIGGER trg_authorization_request_transition_not_expired
BEFORE INSERT ON authorization_request_transitions
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS(
      SELECT 1 FROM authorization_requests r
      WHERE r.id=NEW.request_id AND julianday(r.expires_at)>julianday('now')
    )
    THEN RAISE(ABORT, 'AUTHORIZATION_REQUEST_EXPIRED')
  END);
END;

CREATE TABLE authorization_request_delegations (
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  PRIMARY KEY(request_id,ordinal),
  UNIQUE(delegation_id),
  FOREIGN KEY(request_id,ordinal)
    REFERENCES authorization_request_items(request_id,ordinal) ON DELETE CASCADE
);

UPDATE schema_metadata SET value='49' WHERE key='schema_version';
