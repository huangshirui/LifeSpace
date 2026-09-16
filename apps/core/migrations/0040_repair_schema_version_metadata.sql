-- Repair schema metadata after 0039 added resource provenance without advancing
-- the explicit application-level schema version marker used by /api/v1/status.
--
-- Migration history is append-only: staging has already applied 0039, so the
-- correction must be a new migration rather than an edit to 0039.

UPDATE schema_metadata SET value='40' WHERE key='schema_version';
