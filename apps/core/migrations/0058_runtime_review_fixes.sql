-- Indexed executable external refresh work (#345), with explicit lifecycle.
UPDATE external_models SET next_refresh_at=COALESCE(next_refresh_at,created_at)
WHERE status!='disabled' AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=source_id AND s.status='active');
UPDATE external_models SET next_refresh_at=NULL
WHERE status='disabled' OR NOT EXISTS(SELECT 1 FROM external_sources s WHERE s.id=source_id AND s.status='active');
CREATE INDEX idx_external_refresh_due ON external_models(next_refresh_at,model_key)
WHERE status!='disabled' AND next_refresh_at IS NOT NULL;
CREATE TRIGGER external_source_refresh_lifecycle AFTER UPDATE OF status ON external_sources
WHEN OLD.status!=NEW.status
BEGIN
  UPDATE external_models SET next_refresh_at=NULL WHERE source_id=NEW.id;
  UPDATE external_models SET next_refresh_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE source_id=NEW.id AND NEW.status='active' AND status!='disabled';
END;
-- A current completion-based Task must remain actionable. Cancel/skip/remove
-- the rule explicitly; DELETE cannot silently advance or strand its cursor.
CREATE TRIGGER recurrence_current_task_delete BEFORE UPDATE OF deleted_at ON resource_records
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.model_key='task'
AND EXISTS(SELECT 1 FROM recurrence_occurrences o JOIN recurrence_plans p ON p.plan_record_id=o.plan_record_id
  JOIN resource_records plan ON plan.id=p.plan_record_id AND plan.deleted_at IS NULL
  WHERE o.task_record_id=OLD.id AND p.current_occurrence_id=o.id
    AND o.outcome IN ('active','cancelled') AND json_extract(p.config_json,'$[0].mode')='after_completion')
BEGIN SELECT RAISE(ABORT,'RECURRENCE_CURRENT_TASK_DELETE_FORBIDDEN'); END;
UPDATE schema_metadata SET value='58' WHERE key='schema_version';
