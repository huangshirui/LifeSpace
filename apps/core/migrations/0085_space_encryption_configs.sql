-- Schema 85: candidate Space envelope persistence. No backfill or public route.
-- Only wrapped key material is stored; no password, verifier, or raw DEK/KEK.
CREATE TABLE space_encryption_configs (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id),
  key_version INTEGER NOT NULL CHECK(key_version=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 4294967295),
  kdf_salt TEXT NOT NULL CHECK(length(kdf_salt)=22 AND kdf_salt NOT GLOB '*[^A-Za-z0-9_-]*'),
  wrap_nonce TEXT NOT NULL CHECK(length(wrap_nonce)=16 AND wrap_nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  wrapped_dek TEXT NOT NULL CHECK(length(wrapped_dek)=64 AND wrapped_dek NOT GLOB '*[^A-Za-z0-9_-]*'),
  updated_by_user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Candidate format v1 fixes the KDF/cipher profile in the versioned contract.
-- Audit contains no salt, nonce, wrapped key, or password.
CREATE TABLE space_encryption_audit (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  revision INTEGER NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version=1),
  operation TEXT NOT NULL CHECK(operation IN ('initialize','rewrap')),
  actor_user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(space_id,revision)
) WITHOUT ROWID;
CREATE TRIGGER space_encryption_init_audit
AFTER INSERT ON space_encryption_configs
BEGIN
  INSERT INTO space_encryption_audit(space_id,revision,key_version,operation,actor_user_id,application_id,occurred_at)
  VALUES(NEW.space_id,NEW.revision,NEW.key_version,'initialize',NEW.updated_by_user_id,NEW.application_id,NEW.updated_at);
END;
CREATE TRIGGER space_encryption_rewrap_guard
BEFORE UPDATE ON space_encryption_configs
WHEN NEW.space_id<>OLD.space_id OR NEW.key_version<>OLD.key_version
  OR NEW.revision<>OLD.revision+1 OR NEW.kdf_salt=OLD.kdf_salt OR NEW.wrap_nonce=OLD.wrap_nonce
BEGIN
  SELECT RAISE(ABORT,'SPACE_ENCRYPTION_INVALID_REWRAP');
END;
CREATE TRIGGER space_encryption_rewrap_audit
AFTER UPDATE ON space_encryption_configs
BEGIN
  INSERT INTO space_encryption_audit(space_id,revision,key_version,operation,actor_user_id,application_id,occurred_at)
  VALUES(NEW.space_id,NEW.revision,NEW.key_version,'rewrap',NEW.updated_by_user_id,NEW.application_id,NEW.updated_at);
END;
UPDATE schema_metadata SET value='85' WHERE key='schema_version';
