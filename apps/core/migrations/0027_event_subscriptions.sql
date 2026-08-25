PRAGMA foreign_keys = ON;

CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  model_key TEXT NOT NULL,
  include_created INTEGER NOT NULL DEFAULT 1 CHECK(include_created IN (0,1)),
  include_updated INTEGER NOT NULL DEFAULT 1 CHECK(include_updated IN (0,1)),
  include_deleted INTEGER NOT NULL DEFAULT 1 CHECK(include_deleted IN (0,1)),
  webhook_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_event_subscriptions_match
  ON event_subscriptions(space_id, model_key, enabled, application_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_event_subscriptions_application
  ON event_subscriptions(application_id, space_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE domain_event_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('record.created','record.updated','record.deleted')),
  space_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  dispatched_at TEXT,
  dispatch_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_dispatch_attempt_at TEXT,
  last_dispatch_error TEXT
);

CREATE INDEX idx_domain_event_outbox_pending
  ON domain_event_outbox(dispatched_at, occurred_at, id);
CREATE INDEX idx_domain_event_outbox_resource
  ON domain_event_outbox(space_id, model_key, record_id, occurred_at DESC);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES domain_event_outbox(id),
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
  status TEXT NOT NULL CHECK(status IN ('pending','queued','succeeded','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  delivered_at TEXT,
  last_status_code INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id, subscription_id)
);

CREATE INDEX idx_webhook_deliveries_subscription
  ON webhook_deliveries(subscription_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_event
  ON webhook_deliveries(event_id, status);

CREATE TRIGGER trg_domain_event_resource_created
AFTER INSERT ON resource_records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.created',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.created_by_type,
    NEW.created_by_id,
    NEW.created_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_updated
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.updated',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.updated_by_type,
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_deleted
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.deleted',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.updated_by_type,
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

UPDATE schema_metadata
SET value='27'
WHERE key='schema_version';
