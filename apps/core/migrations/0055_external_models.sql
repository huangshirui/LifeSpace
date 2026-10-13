-- External registrations/snapshots only. Provider business records stay external.
CREATE TABLE external_sources (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id),
 provider_key TEXT NOT NULL,
 credential_ref TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX external_sources_space ON external_sources(space_id,status);
CREATE TABLE external_models (
 model_key TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id),
 source_id TEXT NOT NULL REFERENCES external_sources(id),
 provider_key TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 declared_access TEXT NOT NULL CHECK(declared_access IN ('read','write')),
 snapshot_json TEXT NOT NULL,
 schema_hash TEXT NOT NULL,
 schema_observed_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','degraded')),
 last_successful_refresh_at TEXT NOT NULL,
 last_error_code TEXT,
 next_refresh_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(provider_key,resource_id)
);
CREATE INDEX external_models_space ON external_models(space_id,status);
CREATE INDEX external_models_refresh ON external_models(status,next_refresh_at);
-- Identity/linkage metadata only, never provider business values.
CREATE TABLE external_record_identities (
 record_id TEXT PRIMARY KEY,
 model_key TEXT NOT NULL REFERENCES external_models(model_key),
 space_id TEXT NOT NULL REFERENCES spaces(id)
);
CREATE INDEX external_record_model ON external_record_identities(space_id,model_key);
CREATE TABLE external_operation_audit (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL,
 model_key TEXT NOT NULL,
 record_id TEXT,
 application_id TEXT NOT NULL,
 principal_type TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 actor_type TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 delegation_id TEXT,
 delegation_chain_json TEXT NOT NULL,
 operation TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('pending','succeeded','failed','unknown')),
 error_code TEXT,
 bulk_id TEXT,
 occurred_at TEXT NOT NULL,
 completed_at TEXT
);
CREATE INDEX external_audit_model ON external_operation_audit(space_id,model_key,occurred_at);
UPDATE schema_metadata SET value='55' WHERE key='schema_version';
