-- Non-breaking extension of Identity-owned global OAuth admission policy.
-- Open modes remove the operational need to add every user's callback to Console.
-- Individual registered clients still require exact redirect URI checks.
ALTER TABLE oauth_client_admission_policy
  ADD COLUMN cimd_mode TEXT NOT NULL DEFAULT 'restricted'
  CHECK(cimd_mode IN ('restricted','open'));
ALTER TABLE oauth_client_admission_policy
  ADD COLUMN dcr_mode TEXT NOT NULL DEFAULT 'restricted'
  CHECK(dcr_mode IN ('restricted','open'));
ALTER TABLE oauth_client_admission_policy
  ADD COLUMN callback_mode TEXT NOT NULL DEFAULT 'client'
  CHECK(callback_mode IN ('client','restricted'));
ALTER TABLE oauth_client_admission_policy
  ADD COLUMN callback_uris_json TEXT NOT NULL DEFAULT '[]';
UPDATE schema_metadata SET value='17' WHERE key='schema_version';
