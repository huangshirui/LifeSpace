PRAGMA foreign_keys = ON;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 5000),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  completed_at TEXT,
  completed_by_type TEXT CHECK (completed_by_type IS NULL OR completed_by_type IN ('user', 'service', 'device')),
  completed_by_id TEXT,
  completed_by_name_snapshot TEXT,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'service', 'device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  updated_by_type TEXT NOT NULL CHECK (updated_by_type IN ('user', 'service', 'device')),
  updated_by_id TEXT NOT NULL,
  updated_by_name_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_type TEXT CHECK (deleted_by_type IS NULL OR deleted_by_type IN ('user', 'service', 'device')),
  deleted_by_id TEXT,
  mutation_token TEXT,
  CHECK ((deleted_by_type IS NULL) = (deleted_by_id IS NULL)),
  CHECK (
    (status = 'completed'
      AND completed_at IS NOT NULL
      AND completed_by_type IS NOT NULL
      AND completed_by_id IS NOT NULL
      AND completed_by_name_snapshot IS NOT NULL)
    OR
    (status != 'completed'
      AND completed_at IS NULL
      AND completed_by_type IS NULL
      AND completed_by_id IS NULL
      AND completed_by_name_snapshot IS NULL)
  )
);
CREATE INDEX idx_tasks_space_due ON tasks(space_id, due_date, id);
CREATE INDEX idx_tasks_space_status_due ON tasks(space_id, status, due_date, id);
CREATE INDEX idx_tasks_space_created ON tasks(space_id, created_at, id);
CREATE INDEX idx_tasks_space_updated ON tasks(space_id, updated_at, id);
CREATE INDEX idx_tasks_space_deleted ON tasks(space_id, deleted_at);

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  person_id TEXT NOT NULL REFERENCES space_people(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, person_id)
);
CREATE INDEX idx_task_assignees_person ON task_assignees(person_id, task_id);

CREATE TRIGGER enforce_task_assignee_space_on_insert
BEFORE INSERT ON task_assignees
WHEN NOT EXISTS (
  SELECT 1
  FROM tasks t
  JOIN space_people p ON p.id = NEW.person_id AND p.space_id = t.space_id
  WHERE t.id = NEW.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_ASSIGNEE_SPACE_MISMATCH');
END;

UPDATE schema_metadata SET value = '5' WHERE key = 'schema_version';
