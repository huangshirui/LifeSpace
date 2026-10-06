-- PBD Person foundation: active alternate names belong to Space Person Kernel state.
-- Stored names are normalized before insertion by callers; display_name remains the
-- canonical label projected by Person reference lookup/resolution.

CREATE TABLE space_person_names (
  id TEXT PRIMARY KEY CHECK(id GLOB 'spn_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  person_id TEXT NOT NULL REFERENCES space_people(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX uq_active_space_person_name
  ON space_person_names(space_id, person_id, name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_space_person_names_lookup
  ON space_person_names(space_id, name COLLATE NOCASE, person_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_space_person_names_person
  ON space_person_names(space_id, person_id, deleted_at);

UPDATE schema_metadata SET value='51' WHERE key='schema_version';
