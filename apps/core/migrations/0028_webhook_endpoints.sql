PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS event_subscriptions;

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  subscriber_service_principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_webhook_endpoints_application
  ON webhook_endpoints(application_id, space_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_webhook_endpoints_subscriber
  ON webhook_endpoints(subscriber_service_principal_id, space_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  model_key TEXT NOT NULL,
  include_created INTEGER NOT NULL DEFAULT 1 CHECK(include_created IN (0,1)),
  include_updated INTEGER NOT NULL DEFAULT 1 CHECK(include_updated IN (0,1)),
  include_deleted INTEGER NOT NULL DEFAULT 1 CHECK(include_deleted IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_event_subscriptions_endpoint_model
  ON event_subscriptions(endpoint_id, model_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_event_subscriptions_match
  ON event_subscriptions(model_key, enabled, endpoint_id)
  WHERE deleted_at IS NULL;

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

UPDATE schema_metadata
SET value='28'
WHERE key='schema_version';

PRAGMA foreign_keys = ON;
