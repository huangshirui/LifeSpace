PRAGMA foreign_keys = ON;

-- Retire migration-era consumer schema and the product-specific Space kind
-- classification. Historical numbered migrations remain immutable; this
-- migration defines the current platform schema.

DROP TRIGGER IF EXISTS enforce_homemew_created_family_limit;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_insert;
DROP TRIGGER IF EXISTS enforce_family_member_limit_on_reactivation;

DROP TABLE IF EXISTS legacy_homemew_invite_maps;
DROP TABLE IF EXISTS legacy_homemew_membership_maps;
DROP TABLE IF EXISTS legacy_homemew_family_maps;
DROP TABLE IF EXISTS legacy_homemew_user_maps;

ALTER TABLE spaces DROP COLUMN kind;

UPDATE schema_metadata
SET value='44'
WHERE key='schema_version';
