import type { ModelDefinition } from "../src/model-definition";
import { compilePhysicalSchema } from "../src/physical-schema";
import type { PublishedModel } from "../src/model-registry";

export const LEGACY_CALENDAR_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "legacy_calendar_probe",
  display: { singular: "Legacy Calendar Probe", plural: "Legacy Calendar Probes" },
  fields: {
    summary: { type: "string", required: true, minLength: 1, maxLength: 100 },
    description: { type: "text", nullable: true, maxLength: 5000 },
    location: { type: "string", nullable: true, maxLength: 500 },
    isAllDay: { type: "boolean", required: true },
    startAt: { type: "datetime", nullable: true },
    endAt: { type: "datetime", nullable: true },
    startTimezone: { type: "timezone", nullable: true },
    endTimezone: { type: "timezone", nullable: true },
    startDate: { type: "date", nullable: true },
    endDateExclusive: { type: "date", nullable: true },
    attendeePersonIds: { type: "person_list" },
    status: { type: "enum", required: true, values: ["active", "cancelled"] },
  },
  defaults: { status: "active" },
  query: {
    searchable: ["summary", "description", "location"],
    filterable: ["status", "isAllDay", "startAt", "startDate", "attendeePersonIds"],
    sortable: ["startAt", "startDate", "summary"],
  },
  access: ["read", "write"],
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  capabilities: {
    calendar: {
      allDayField: "isAllDay",
      timedStartField: "startAt",
      timedEndField: "endAt",
      startTimezoneField: "startTimezone",
      endTimezoneField: "endTimezone",
      allDayStartField: "startDate",
      allDayEndExclusiveField: "endDateExclusive",
      attendeePersonField: "attendeePersonIds",
    },
  },
};

export const LEGACY_CALENDAR_MODEL: PublishedModel = {
  id: "mdl_legacy_calendar_probe",
  key: LEGACY_CALENDAR_MODEL_DEFINITION.key,
  version: 1,
  state: "published",
  schemaHash: "legacy-calendar-probe",
  compatibility: "initial",
  definition: LEGACY_CALENDAR_MODEL_DEFINITION,
  publishedAt: "2026-09-17T00:00:00.000Z",
};

export async function ensureLegacyCalendarStorage(db: D1Database): Promise<void> {
  const plan = compilePhysicalSchema(LEGACY_CALENDAR_MODEL_DEFINITION);
  await db.prepare(plan.createTableSql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")).run();
  for (const statement of plan.createIndexSql) {
    await db.prepare(statement.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")).run();
  }
}
