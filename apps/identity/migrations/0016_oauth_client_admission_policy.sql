-- Identity-owned OAuth client admission, managed by LifeSpace Console.
-- A whitelist is registration eligibility, not vendor authentication or a Data Grant.
-- Start disabled with empty exact-match lists; no runtime Wrangler allowlist needed.
CREATE TABLE oauth_client_admission_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cimd_enabled INTEGER NOT NULL DEFAULT 0 CHECK (cimd_enabled IN (0, 1)),
  dcr_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dcr_enabled IN (0, 1)),
  cimd_client_ids_json TEXT NOT NULL DEFAULT '[]',
  dcr_redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by_user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO oauth_client_admission_policy(
  id, cimd_enabled, dcr_enabled, cimd_client_ids_json,
  dcr_redirect_uris_json, revision, updated_at
) VALUES (1,0,0,'[]','[]',1,STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE schema_metadata SET value='16' WHERE key='schema_version';
