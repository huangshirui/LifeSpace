PRAGMA foreign_keys = ON;

-- Historical consumer-migration helpers are no longer part of the current
-- LifeSpace schema. Applied migrations remain immutable; this migration
-- converges the final schema instead of rewriting migration history.
DROP TRIGGER IF EXISTS enforce_homemew_created_family_limit;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_insert;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_reactivation;

DROP TABLE IF EXISTS legacy_homemew_invite_maps;
DROP TABLE IF EXISTS legacy_homemew_membership_maps;
DROP TABLE IF EXISTS legacy_homemew_family_maps;
DROP TABLE IF EXISTS legacy_homemew_user_maps;

-- Space is the platform authority/shared-reality boundary. Product categories
-- such as family/team/personal are not Kernel semantics.
ALTER TABLE spaces DROP COLUMN kind;

UPDATE schema_metadata SET value='44' WHERE key='schema_version';
