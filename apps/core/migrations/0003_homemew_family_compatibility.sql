PRAGMA foreign_keys = ON;

-- Transitional HomeMew IDs are compatibility/migration metadata only. The
-- authoritative household records remain spaces, memberships, people, and
-- invites.
CREATE TABLE legacy_homemew_user_maps (
  legacy_user_id TEXT PRIMARY KEY,
  lifespace_user_id TEXT NOT NULL UNIQUE,
  display_name_snapshot TEXT NOT NULL CHECK (length(trim(display_name_snapshot)) BETWEEN 1 AND 100),
  source_status TEXT NOT NULL CHECK (source_status IN ('active','disabled')),
  migrated_at TEXT NOT NULL
);

CREATE TABLE legacy_homemew_family_maps (
  legacy_family_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id),
  legacy_created_by_user_id TEXT NOT NULL REFERENCES legacy_homemew_user_maps(legacy_user_id),
  migrated_at TEXT NOT NULL
);
CREATE INDEX idx_legacy_homemew_family_creator
ON legacy_homemew_family_maps(legacy_created_by_user_id);

CREATE TRIGGER enforce_homemew_created_family_limit
BEFORE INSERT ON legacy_homemew_family_maps
WHEN (SELECT deleted_at FROM spaces WHERE id=NEW.space_id) IS NULL
  AND (SELECT COUNT(*) FROM legacy_homemew_family_maps existing
    JOIN spaces s ON s.id=existing.space_id
    WHERE existing.legacy_created_by_user_id=NEW.legacy_created_by_user_id AND s.deleted_at IS NULL)>=3
BEGIN
  SELECT RAISE(ABORT,'FAMILY_CREATE_LIMIT_REACHED');
END;

CREATE TABLE legacy_homemew_membership_maps (
  legacy_membership_id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL UNIQUE REFERENCES space_memberships(id),
  person_id TEXT NOT NULL UNIQUE REFERENCES space_people(id),
  legacy_family_id TEXT NOT NULL REFERENCES legacy_homemew_family_maps(legacy_family_id),
  legacy_user_id TEXT NOT NULL REFERENCES legacy_homemew_user_maps(legacy_user_id),
  migrated_at TEXT NOT NULL,
  UNIQUE(legacy_family_id,legacy_user_id)
);

CREATE TABLE legacy_homemew_invite_maps (
  legacy_invite_id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE REFERENCES space_invites(id),
  legacy_family_id TEXT NOT NULL REFERENCES legacy_homemew_family_maps(legacy_family_id),
  migrated_at TEXT NOT NULL
);

-- Keep the eight-member family invariant authoritative even when writes race
-- or future migration/import tooling bypasses HTTP preflight checks.
CREATE TRIGGER enforce_family_member_limit_on_insert
BEFORE INSERT ON space_memberships
WHEN NEW.deleted_at IS NULL
  AND (SELECT kind FROM spaces WHERE id=NEW.space_id)='family'
  AND (SELECT COUNT(*) FROM space_memberships WHERE space_id=NEW.space_id AND deleted_at IS NULL)>=8
BEGIN
  SELECT RAISE(ABORT,'FAMILY_MEMBER_LIMIT_REACHED');
END;

CREATE TRIGGER enforce_family_member_limit_on_reactivation
BEFORE UPDATE OF deleted_at ON space_memberships
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND (SELECT kind FROM spaces WHERE id=NEW.space_id)='family'
  AND (SELECT COUNT(*) FROM space_memberships WHERE space_id=NEW.space_id AND deleted_at IS NULL)>=8
BEGIN
  SELECT RAISE(ABORT,'FAMILY_MEMBER_LIMIT_REACHED');
END;

UPDATE schema_metadata SET value='3' WHERE key='schema_version';
