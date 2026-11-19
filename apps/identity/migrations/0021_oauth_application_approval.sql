-- Existing applications retain Account confirmation. Application-hosted approval is opt-in and trusted-backend-only.
ALTER TABLE applications ADD COLUMN oauth_delegation_approval TEXT NOT NULL DEFAULT 'account'
  CHECK (oauth_delegation_approval IN ('account','application')
    AND (oauth_delegation_approval = 'account' OR trusted_backend = 1));
UPDATE schema_metadata SET value = '21' WHERE key = 'schema_version';
