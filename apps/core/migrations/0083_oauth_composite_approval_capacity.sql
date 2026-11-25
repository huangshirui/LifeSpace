-- Schema 83: widen the OAuth composite approval item capacity without changing existing request or delegation identity.
CREATE TABLE authorization_request_items_v83 (
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63),
  target_type TEXT NOT NULL CHECK(target_type IN ('space','model','record')),
  target_id TEXT NOT NULL,
  max_access TEXT NOT NULL CHECK(max_access IN ('free_busy','read','write','manage')),
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses=1),
  delegation_expires_at TEXT,
  remaining_redelegation_depth INTEGER NOT NULL DEFAULT 0
    CHECK(remaining_redelegation_depth BETWEEN 0 AND 3),
  PRIMARY KEY(request_id,ordinal)
);

CREATE TABLE authorization_request_delegations_v83 (
  request_id TEXT NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  PRIMARY KEY(request_id,ordinal),
  UNIQUE(delegation_id),
  FOREIGN KEY(request_id,ordinal)
    REFERENCES authorization_request_items_v83(request_id,ordinal) ON DELETE CASCADE
);

INSERT INTO authorization_request_items_v83 SELECT * FROM authorization_request_items;
INSERT INTO authorization_request_delegations_v83 SELECT * FROM authorization_request_delegations;
DROP TABLE authorization_request_delegations;
DROP TABLE authorization_request_items;
ALTER TABLE authorization_request_items_v83 RENAME TO authorization_request_items;
ALTER TABLE authorization_request_delegations_v83 RENAME TO authorization_request_delegations;
UPDATE schema_metadata SET value='83' WHERE key='schema_version';
