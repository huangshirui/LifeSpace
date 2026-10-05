-- #306: first-class Authorization Request protocol for Agent user confirmation.
--
-- Authorization Requests are durable pending Authority intents. They grant no
-- Authority by themselves. Root Delegations are materialized only when a pending
-- request is confirmed and all current Principal Authority checks still pass.

CREATE TABLE authorization_requests (
  id TEXT PRIMARY KEY CHECK(id GLOB 'arq_*'),
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  application_id TEXT NOT NULL,
  requesting_agent_id TEXT NOT NULL CHECK(requesting_agent_id GLOB 'agt_*'),
  principal_user_id TEXT NOT NULL CHECK(principal_user_id GLOB 'usr_*'),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled','expired')),
  dedupe_key TEXT NOT NULL,
  requested_items_json TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 20),
  correlation_json TEXT,
  request_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

-- Only one semantically identical pending request may exist at once. Expired
-- rows are materialized to status=expired before a replacement is inserted.
CREATE UNIQUE INDEX idx_authorization_requests_pending_dedupe
  ON authorization_requests(dedupe_key)
  WHERE status='pending';

CREATE INDEX idx_authorization_requests_requester
  ON authorization_requests(application_id,requesting_agent_id,status,created_at DESC);

CREATE INDEX idx_authorization_requests_principal
  ON authorization_requests(principal_user_id,status,created_at DESC);

-- Plaintext reviewToken is never persisted. Multiple tokens may point at the same
-- reused pending request so idempotent callers can each receive a usable opaque
-- continuation secret without rotating/invalidation races.
CREATE TABLE authorization_request_review_tokens (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_authorization_request_review_tokens_request
  ON authorization_request_review_tokens(request_id,created_at DESC);

-- Durable evidence linking one approved request item to exactly one materialized
-- Delegation. This also provides the transaction guard for concurrent confirms.
CREATE TABLE authorization_request_delegations (
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK(item_index BETWEEN 0 AND 19),
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  PRIMARY KEY(request_id,item_index),
  UNIQUE(delegation_id)
);

CREATE TRIGGER trg_authorization_request_delegation_pending
BEFORE INSERT ON authorization_request_delegations
WHEN NOT EXISTS(
  SELECT 1
  FROM authorization_requests r
  WHERE r.id=NEW.request_id
    AND r.status='pending'
    AND NEW.item_index < r.item_count
    AND julianday(r.request_expires_at) > julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'AUTH_REQUEST_NOT_PENDING');
END;

CREATE TRIGGER trg_authorization_request_approve_complete
BEFORE UPDATE OF status ON authorization_requests
WHEN OLD.status='pending' AND NEW.status='approved'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM authorization_request_delegations d
      WHERE d.request_id=OLD.id
    ) <> OLD.item_count
    THEN RAISE(ABORT, 'AUTH_REQUEST_APPROVAL_INCOMPLETE')
  END);
END;

UPDATE schema_metadata SET value='49' WHERE key='schema_version';
