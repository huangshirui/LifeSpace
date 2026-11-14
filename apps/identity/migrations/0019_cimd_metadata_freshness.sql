-- Validated public CIMD metadata freshness is not an OAuth Authorization.
-- Existing registered clients begin with no freshness proof.
CREATE TABLE oauth_cimd_metadata_cache (
  client_id TEXT PRIMARY KEY REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uris TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
  fresh_until_ms INTEGER NOT NULL CHECK(fresh_until_ms >= 0)
);
UPDATE schema_metadata SET value='19' WHERE key='schema_version';
