PRAGMA foreign_keys = ON;

-- Retire migration-era consumer schema and product-specific family invariants.
-- Space.kind remains only as a deprecated Stable-wire compatibility field until
-- the next explicitly breaking Kernel contract version.

DROP TRIGGER IF EXISTS enforce_homemew_created_family_limit;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_insert;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_reactivation;

DROP TABLE IF EXISTS legacy_homemew_invite_maps;
DROP TABLE IF EXISTS legacy_homemew_membership_maps;
DROP TABLE IF EXISTS legacy_homemew_family_maps;
DROP TABLE IF EXISTS legacy_homemew_user_maps;

UPDATE schema_metadata
SET value='44'
WHERE key='schema_version';
