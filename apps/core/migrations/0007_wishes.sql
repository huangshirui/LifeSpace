PRAGMA foreign_keys = ON;

CREATE TABLE wishes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  owner_person_id TEXT NOT NULL REFERENCES space_people(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 5000),
  desired_date TEXT CHECK (desired_date IS NULL OR (date(desired_date) IS NOT NULL AND date(desired_date) = desired_date)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','fulfilled','archived')),
  claimant_person_id TEXT REFERENCES space_people(id),
  claimed_at TEXT,
  fulfilled_by_person_id TEXT REFERENCES space_people(id),
  fulfilled_at TEXT,
  archived_from_status TEXT CHECK (archived_from_status IS NULL OR archived_from_status IN ('open','claimed','fulfilled')),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user','service','device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  updated_by_type TEXT NOT NULL CHECK (updated_by_type IN ('user','service','device')),
  updated_by_id TEXT NOT NULL,
  updated_by_name_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_type TEXT CHECK (deleted_by_type IS NULL OR deleted_by_type IN ('user','service','device')),
  deleted_by_id TEXT,
  mutation_token TEXT,
  CHECK ((claimant_person_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((fulfilled_by_person_id IS NULL) = (fulfilled_at IS NULL)),
  CHECK ((deleted_by_type IS NULL) = (deleted_by_id IS NULL)),
  CHECK (
    (status='open' AND claimant_person_id IS NULL AND fulfilled_by_person_id IS NULL AND archived_from_status IS NULL)
    OR (status='claimed' AND claimant_person_id IS NOT NULL AND fulfilled_by_person_id IS NULL AND archived_from_status IS NULL)
    OR (status='fulfilled' AND fulfilled_by_person_id IS NOT NULL AND archived_from_status IS NULL)
    OR (status='archived' AND archived_from_status IS NOT NULL)
  )
);

CREATE INDEX idx_wishes_space_status ON wishes(space_id,status,deleted_at);
CREATE INDEX idx_wishes_space_owner ON wishes(space_id,owner_person_id,status);
CREATE INDEX idx_wishes_space_claimant ON wishes(space_id,claimant_person_id,status);
CREATE INDEX idx_wishes_space_desired ON wishes(space_id,desired_date,id);
CREATE INDEX idx_wishes_space_created ON wishes(space_id,created_at,id);
CREATE INDEX idx_wishes_space_updated ON wishes(space_id,updated_at,id);

CREATE TRIGGER enforce_wish_people_space_on_insert
BEFORE INSERT ON wishes
WHEN NOT EXISTS (
  SELECT 1 FROM space_people p WHERE p.id=NEW.owner_person_id AND p.space_id=NEW.space_id
) OR (
  NEW.claimant_person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM space_people p WHERE p.id=NEW.claimant_person_id AND p.space_id=NEW.space_id
  )
) OR (
  NEW.fulfilled_by_person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM space_people p WHERE p.id=NEW.fulfilled_by_person_id AND p.space_id=NEW.space_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'WISH_PERSON_SPACE_MISMATCH');
END;

CREATE TRIGGER enforce_wish_people_space_on_update
BEFORE UPDATE OF owner_person_id,claimant_person_id,fulfilled_by_person_id,space_id ON wishes
WHEN NOT EXISTS (
  SELECT 1 FROM space_people p WHERE p.id=NEW.owner_person_id AND p.space_id=NEW.space_id
) OR (
  NEW.claimant_person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM space_people p WHERE p.id=NEW.claimant_person_id AND p.space_id=NEW.space_id
  )
) OR (
  NEW.fulfilled_by_person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM space_people p WHERE p.id=NEW.fulfilled_by_person_id AND p.space_id=NEW.space_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'WISH_PERSON_SPACE_MISMATCH');
END;

UPDATE schema_metadata SET value = '7' WHERE key = 'schema_version';
