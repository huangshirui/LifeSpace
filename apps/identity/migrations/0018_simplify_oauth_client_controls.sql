-- Simplify platform OAuth controls without silently broadening legacy restrictions.
-- Existing strict CIMD/DCR rules cannot be promoted to open enrollment automatically:
-- disable those feature switches first; an administrator must explicitly enable.
-- Global callback restrictions remain intact when explicitly selected.
UPDATE oauth_client_admission_policy SET
  cimd_enabled=CASE WHEN cimd_mode='restricted' THEN 0 ELSE cimd_enabled END,
  dcr_enabled=CASE WHEN dcr_mode='restricted' THEN 0 ELSE dcr_enabled END,
  cimd_mode='open',
  dcr_mode='open',
  cimd_client_ids_json='[]',
  dcr_redirect_uris_json='[]',
  callback_uris_json=CASE WHEN callback_mode='restricted' THEN callback_uris_json ELSE '[]' END,
  revision=revision+1,
  updated_at=STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id=1;
UPDATE schema_metadata SET value='18' WHERE key='schema_version';
