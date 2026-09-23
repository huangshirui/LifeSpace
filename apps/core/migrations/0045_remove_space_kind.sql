PRAGMA foreign_keys = ON;

-- Space.kind was deprecated in Kernel 0.38.0 after all product semantics were
-- removed. Kernel 0.39.0 completes the explicit breaking-contract migration by
-- removing the compatibility storage column.

ALTER TABLE spaces DROP COLUMN kind;

UPDATE schema_metadata
SET value='45'
WHERE key='schema_version';
