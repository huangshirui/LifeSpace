-- Schema 82: endpoint-scoped delivery history includes retired filters.
-- Keep active-only unique/matching indexes and existing delivery indexes.
-- Additive only: old Worker remains compatible, no business row mutation.
CREATE INDEX idx_event_subscriptions_endpoint_history
  ON event_subscriptions(endpoint_id,id);
UPDATE schema_metadata SET value='82' WHERE key='schema_version';
