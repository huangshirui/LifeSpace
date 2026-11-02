-- Schema 77: unified Connection management metadata (currently no public routes).
-- This table is NOT the External Data provider connection table (cnx_*) and
-- never stores credentials, bearer tokens, authorization Grants or Delegations.
-- Identity owns service/agent credential state; Eventing and External retain
-- their own backing resource implementations.
CREATE TABLE unified_connections (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'conn_*'),
  application_id TEXT NOT NULL CHECK (length(application_id) BETWEEN 1 AND 128),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent','service','event_push','external_data')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled','revoked')),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','space')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  identity_type TEXT CHECK (identity_type IS NULL OR identity_type IN ('agent','service')),
  identity_id TEXT CHECK (identity_id IS NULL OR length(identity_id) BETWEEN 5 AND 128),
  backing_type TEXT CHECK (backing_type IS NULL OR backing_type IN ('webhook_endpoint','external_provider')),
  backing_id TEXT CHECK (backing_id IS NULL OR length(backing_id) BETWEEN 5 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (owner_type != 'space' OR owner_id = space_id),
  CHECK ((identity_type IS NULL) = (identity_id IS NULL)),
  CHECK ((backing_type IS NULL) = (backing_id IS NULL)),
  CHECK ((kind = 'agent' AND (identity_type IS NULL OR (identity_type = 'agent' AND identity_id GLOB 'agt_*')))
      OR (kind = 'service' AND (identity_type IS NULL OR (identity_type = 'service' AND identity_id GLOB 'svc_*')))
      OR (kind IN ('event_push','external_data') AND identity_id IS NULL)),
  CHECK ((kind = 'event_push' AND (backing_type IS NULL OR backing_type = 'webhook_endpoint'))
      OR (kind = 'external_data' AND (backing_type IS NULL OR (backing_type = 'external_provider' AND backing_id GLOB 'cnx_*')))
      OR (kind IN ('agent','service') AND backing_type IS NULL)),
  CHECK (status != 'active' OR
    ((kind IN ('agent','service') AND identity_id IS NOT NULL)
      OR (kind IN ('event_push','external_data') AND backing_id IS NOT NULL))),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_unified_connections_identity
  ON unified_connections(identity_type, identity_id)
  WHERE identity_id IS NOT NULL;
CREATE UNIQUE INDEX idx_unified_connections_backing
  ON unified_connections(backing_type, backing_id)
  WHERE backing_id IS NOT NULL;
CREATE INDEX idx_unified_connections_space
  ON unified_connections(space_id, status, created_at DESC, id);
CREATE INDEX idx_unified_connections_application
  ON unified_connections(application_id, status, created_at DESC, id);
CREATE INDEX idx_unified_connections_owner
  ON unified_connections(owner_type, owner_id, status, created_at DESC, id);

-- A Connection never silently changes Application/Space/kind/owner or
-- an identity/backing resource once that resource has been provisioned.
CREATE TRIGGER unified_connections_fixed_boundary
BEFORE UPDATE ON unified_connections
WHEN OLD.application_id != NEW.application_id
  OR OLD.space_id != NEW.space_id
  OR OLD.kind != NEW.kind
  OR OLD.owner_type != NEW.owner_type
  OR OLD.owner_id != NEW.owner_id
  OR (OLD.identity_id IS NOT NULL AND (
    NEW.identity_id IS NOT OLD.identity_id OR NEW.identity_type IS NOT OLD.identity_type))
  OR (OLD.backing_id IS NOT NULL AND (
    NEW.backing_id IS NOT OLD.backing_id OR NEW.backing_type IS NOT OLD.backing_type))
  OR OLD.status = 'revoked'
BEGIN
  SELECT RAISE(ABORT, 'immutable or revoked connection');
END;

UPDATE schema_metadata SET value='77' WHERE key='schema_version';
