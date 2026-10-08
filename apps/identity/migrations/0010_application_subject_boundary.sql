PRAGMA foreign_keys = ON;

-- Application is the registered platform access subject. Web, Mini Program,
-- service, device, BFF and deployment topology are application-owned details,
-- not LifeSpace application identity.
ALTER TABLE applications DROP COLUMN client_type;

UPDATE schema_metadata SET value = '10' WHERE key = 'schema_version';
