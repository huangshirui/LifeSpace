PRAGMA foreign_keys = ON;

DROP INDEX uq_access_audience;
CREATE UNIQUE INDEX uq_access_audience_active
  ON access_audiences(issuer, audience)
  WHERE status = 'active';

UPDATE schema_metadata SET value = '11' WHERE key = 'schema_version';
