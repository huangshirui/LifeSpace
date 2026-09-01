PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_applications (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(agent_id, application_id)
);

CREATE INDEX idx_agent_applications_application
  ON agent_applications(application_id, status, agent_id);

UPDATE schema_metadata SET value='8' WHERE key='schema_version';
