from pathlib import Path

path = Path("apps/core/migrations/0067_file_upload_capability.sql")
text = path.read_text()
old = '''  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM resource_records r
    JOIN files f ON f.id=NEW.file_id
    WHERE r.id=NEW.source_record_id
      AND r.space_id=NEW.source_space_id
      AND r.model_key=NEW.source_model_key
      AND r.deleted_at IS NULL
      AND f.space_id=NEW.source_space_id
      AND f.status='ready'
  ) THEN RAISE(ABORT, 'FILE_REFERENCE_INVALID') END;'''
new = '''  SELECT (CASE WHEN NOT EXISTS(
    SELECT 1 FROM resource_records r
    JOIN files f ON f.id=NEW.file_id
    WHERE r.id=NEW.source_record_id
      AND r.space_id=NEW.source_space_id
      AND r.model_key=NEW.source_model_key
      AND r.deleted_at IS NULL
      AND f.space_id=NEW.source_space_id
      AND f.status='ready'
  ) THEN RAISE(ABORT, 'FILE_REFERENCE_INVALID') END);'''
if old not in text:
    raise SystemExit("file-reference trigger anchor not found")
path.write_text(text.replace(old, new, 1))
