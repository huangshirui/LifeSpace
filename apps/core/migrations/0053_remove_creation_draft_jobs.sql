-- Retire the experimental natural-language creation orchestration persistence surface.
-- Historical migrations remain immutable; current schema no longer carries its job table.

DROP TABLE IF EXISTS creation_draft_jobs;

UPDATE schema_metadata SET value='53' WHERE key='schema_version';
