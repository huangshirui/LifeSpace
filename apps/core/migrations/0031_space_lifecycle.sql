-- Space lifecycle audit for owner-initiated logical closure.
-- Closing a Space uses spaces.deleted_at as the terminal logical-close marker;
-- ordinary Space-owned Shared Reality is retained and is not physically deleted.

CREATE TABLE space_lifecycle_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('closed')),
  actor_user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_space_lifecycle_events_space
  ON space_lifecycle_events(space_id, occurred_at DESC);

UPDATE schema_metadata SET value='31' WHERE key='schema_version';
