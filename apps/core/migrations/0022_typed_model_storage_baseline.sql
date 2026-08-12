-- Phase 3 typed-storage convergence baseline.
--
-- These four tables are a one-time bridge for models that were already published
-- before the Physical Schema Compiler existed. Future ordinary models and
-- compatible model changes must obtain their physical DDL from the validated
-- runtime publication path rather than from handwritten repository migrations.

CREATE TABLE "mdl_task" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "completedAt" TEXT,
  "completedById" TEXT,
  "completedByType" TEXT CHECK("completedByType" IS NULL OR "completedByType" IN ('user','service','device')),
  "description" TEXT,
  "dueDate" TEXT,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('pending','completed','cancelled')),
  UNIQUE(space_id,record_id)
);

CREATE INDEX "idx_mdl_task_dueDate" ON "mdl_task"(space_id,"dueDate",record_id);
CREATE INDEX "idx_mdl_task_name" ON "mdl_task"(space_id,"name",record_id);
CREATE INDEX "idx_mdl_task_status" ON "mdl_task"(space_id,"status",record_id);

CREATE TABLE "mdl_wish" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "archivedFromStatus" TEXT CHECK("archivedFromStatus" IS NULL OR "archivedFromStatus" IN ('open','claimed','fulfilled')),
  "claimedAt" TEXT,
  "description" TEXT,
  "desiredDate" TEXT,
  "fulfilledAt" TEXT,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('open','claimed','fulfilled','archived')),
  "title" TEXT NOT NULL,
  UNIQUE(space_id,record_id)
);

CREATE INDEX "idx_mdl_wish_desiredDate" ON "mdl_wish"(space_id,"desiredDate",record_id);
CREATE INDEX "idx_mdl_wish_status" ON "mdl_wish"(space_id,"status",record_id);
CREATE INDEX "idx_mdl_wish_title" ON "mdl_wish"(space_id,"title",record_id);

CREATE TABLE "mdl_day_record" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "anchorDate" TEXT NOT NULL,
  "attentionAfterDays" INTEGER,
  "attentionBeforeDays" INTEGER,
  "cycleDays" INTEGER,
  "description" TEXT,
  "icon" TEXT,
  "kind" TEXT NOT NULL CHECK("kind" IS NULL OR "kind" IN ('elapsed','countdown','cycle')),
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('active','archived')),
  UNIQUE(space_id,record_id)
);

CREATE INDEX "idx_mdl_day_record_anchorDate" ON "mdl_day_record"(space_id,"anchorDate",record_id);
CREATE INDEX "idx_mdl_day_record_kind" ON "mdl_day_record"(space_id,"kind",record_id);
CREATE INDEX "idx_mdl_day_record_name" ON "mdl_day_record"(space_id,"name",record_id);
CREATE INDEX "idx_mdl_day_record_status" ON "mdl_day_record"(space_id,"status",record_id);

CREATE TABLE "mdl_event" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "description" TEXT,
  "endAt" TEXT,
  "endDateExclusive" TEXT,
  "endTimezone" TEXT,
  "isAllDay" INTEGER NOT NULL CHECK("isAllDay" IS NULL OR "isAllDay" IN (0,1)),
  "location" TEXT,
  "startAt" TEXT,
  "startDate" TEXT,
  "startTimezone" TEXT,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('active','cancelled')),
  "summary" TEXT NOT NULL,
  UNIQUE(space_id,record_id)
);

CREATE INDEX "idx_mdl_event_isAllDay" ON "mdl_event"(space_id,"isAllDay",record_id);
CREATE INDEX "idx_mdl_event_startAt" ON "mdl_event"(space_id,"startAt",record_id);
CREATE INDEX "idx_mdl_event_startDate" ON "mdl_event"(space_id,"startDate",record_id);
CREATE INDEX "idx_mdl_event_status" ON "mdl_event"(space_id,"status",record_id);
CREATE INDEX "idx_mdl_event_summary" ON "mdl_event"(space_id,"summary",record_id);

UPDATE schema_metadata SET value='22' WHERE key='schema_version';
