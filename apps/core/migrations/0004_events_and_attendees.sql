PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 5000),
  start_at TEXT,
  end_at TEXT,
  start_date TEXT,
  end_date TEXT,
  is_all_day INTEGER NOT NULL CHECK (is_all_day IN (0, 1)),
  start_timezone TEXT,
  end_timezone TEXT,
  location TEXT CHECK (location IS NULL OR length(location) <= 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'service', 'device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  updated_by_type TEXT NOT NULL CHECK (updated_by_type IN ('user', 'service', 'device')),
  updated_by_id TEXT NOT NULL,
  updated_by_name_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_type TEXT CHECK (deleted_by_type IS NULL OR deleted_by_type IN ('user', 'service', 'device')),
  deleted_by_id TEXT,
  mutation_token TEXT,
  CHECK ((deleted_by_type IS NULL) = (deleted_by_id IS NULL)),
  CHECK (
    (is_all_day = 0
      AND start_at IS NOT NULL AND end_at IS NOT NULL
      AND start_date IS NULL AND end_date IS NULL
      AND end_at > start_at)
    OR
    (is_all_day = 1
      AND start_at IS NULL AND end_at IS NULL
      AND start_date IS NOT NULL AND end_date IS NOT NULL
      AND start_timezone IS NULL AND end_timezone IS NULL
      AND end_date > start_date)
  )
);
CREATE INDEX idx_events_space_start ON events(space_id, start_at, id);
CREATE INDEX idx_events_space_dates ON events(space_id, start_date, id);
CREATE INDEX idx_events_space_status ON events(space_id, status, deleted_at);

CREATE TABLE event_attendees (
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES space_people(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, person_id)
);
CREATE INDEX idx_event_attendees_person ON event_attendees(person_id, event_id);

CREATE TRIGGER enforce_event_attendee_space_on_insert
BEFORE INSERT ON event_attendees
WHEN NOT EXISTS (
  SELECT 1
  FROM events e
  JOIN space_people p ON p.id = NEW.person_id AND p.space_id = e.space_id
  WHERE e.id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'EVENT_ATTENDEE_SPACE_MISMATCH');
END;

UPDATE schema_metadata SET value = '4' WHERE key = 'schema_version';
