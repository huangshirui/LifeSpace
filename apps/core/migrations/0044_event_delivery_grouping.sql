-- #276: preserve one-operation webhook callback semantics for Generic Batch Create.
--
-- Domain Events remain one fact per ordinary-model record mutation. A bounded
-- Batch Create may attach several events to one explicit operation_group_id so
-- Eventing can deliver one callback per Webhook Endpoint with the matching
-- events instead of N independent callbacks. Unrelated events never receive an
-- operation group and therefore remain independently delivered.

ALTER TABLE domain_event_outbox
  ADD COLUMN operation_group_id TEXT
  CHECK(operation_group_id IS NULL OR operation_group_id GLOB 'opg_*');

ALTER TABLE domain_event_outbox
  ADD COLUMN operation_group_ordinal INTEGER
  CHECK(operation_group_ordinal IS NULL OR operation_group_ordinal >= 0);

CREATE INDEX idx_domain_event_outbox_operation_group
  ON domain_event_outbox(operation_group_id, operation_group_ordinal, occurred_at, id)
  WHERE operation_group_id IS NOT NULL;

-- Keep the historical anchor event/subscription columns for compatibility and
-- durable FK ownership, but make the delivery itself capable of representing
-- multiple event/subscription matches.
ALTER TABLE webhook_deliveries ADD COLUMN endpoint_id TEXT REFERENCES webhook_endpoints(id);
ALTER TABLE webhook_deliveries ADD COLUMN delivery_key TEXT;
ALTER TABLE webhook_deliveries
  ADD COLUMN operation_group_id TEXT
  CHECK(operation_group_id IS NULL OR operation_group_id GLOB 'opg_*');
ALTER TABLE webhook_deliveries
  ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1
  CHECK(event_count >= 1);

UPDATE webhook_deliveries
SET endpoint_id=(
      SELECT s.endpoint_id FROM event_subscriptions s WHERE s.id=webhook_deliveries.subscription_id
    ),
    delivery_key='evt:' || event_id || ':' || subscription_id
WHERE delivery_key IS NULL;

CREATE UNIQUE INDEX idx_webhook_deliveries_dedupe
  ON webhook_deliveries(delivery_key)
  WHERE delivery_key IS NOT NULL;

CREATE INDEX idx_webhook_deliveries_endpoint
  ON webhook_deliveries(endpoint_id, created_at DESC);

CREATE TABLE webhook_delivery_events (
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES domain_event_outbox(id),
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(delivery_id,event_id,subscription_id)
);

CREATE INDEX idx_webhook_delivery_events_event
  ON webhook_delivery_events(event_id, delivery_id);

INSERT INTO webhook_delivery_events(delivery_id,event_id,subscription_id,ordinal)
SELECT id,event_id,subscription_id,0
FROM webhook_deliveries;

UPDATE schema_metadata SET value='44' WHERE key='schema_version';
