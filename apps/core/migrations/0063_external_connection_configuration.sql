-- Product-facing External Connection metadata.
-- Provider credential plaintext remains Adapter-owned; Core stores only opaque credential_ref.
ALTER TABLE external_sources ADD COLUMN display_name TEXT;
ALTER TABLE external_sources ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'write' CHECK(access_mode IN ('read','write'));
ALTER TABLE external_sources ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'bootstrap' CHECK(credential_mode IN ('bootstrap','managed'));

UPDATE external_sources
SET display_name = CASE provider_key WHEN 'notion' THEN 'Notion' ELSE provider_key END
WHERE display_name IS NULL;

UPDATE schema_metadata SET value='63' WHERE key='schema_version';
