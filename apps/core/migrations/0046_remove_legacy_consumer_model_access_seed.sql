PRAGMA foreign_keys = ON;

-- Migration 0017 historically bootstrapped one concrete downstream application's
-- model catalog. LifeSpace no longer provisions consumer applications from schema
-- migrations. Remove only rows that still carry the original platform-bootstrap
-- provenance so explicitly reconfigured application access survives.
DELETE FROM application_model_access
WHERE application_id='homemew-miniprogram'
  AND created_by_type='service'
  AND created_by_id='svc_lifespace_bootstrap';

UPDATE schema_metadata
SET value='46'
WHERE key='schema_version';
