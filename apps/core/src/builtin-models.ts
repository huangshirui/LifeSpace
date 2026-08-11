import type { ModelDefinition } from "./model-definition";

export const TASK_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "task",
  route: "tasks",
  display: { singular: "Task", plural: "Tasks" },
  fields: {
    name: { type: "string", required: true, minLength: 1, maxLength: 100 },
    description: { type: "text", nullable: true, maxLength: 5000 },
    dueDate: { type: "date", nullable: true },
    status: { type: "enum", required: true, values: ["pending", "completed", "cancelled"] },
    assigneePersonIds: { type: "person_list" },
    completedAt: { type: "datetime", nullable: true, readOnly: true },
    completedByType: { type: "enum", nullable: true, readOnly: true, values: ["user", "service", "device"] },
    completedById: { type: "string", nullable: true, readOnly: true, maxLength: 100 },
  },
  defaults: { status: "pending" },
  query: { searchable: ["name", "description"], filterable: ["status", "dueDate", "assigneePersonIds"], sortable: ["dueDate", "name"] },
  access: ["read", "write"],
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  actions: {
    complete: {
      access: "write",
      guards: [{ field: "status", op: "neq", value: "completed", errorCode: "TASK_ALREADY_COMPLETED", message: "Task is already completed" }],
      set: { status: "completed", completedAt: { $ref: "now" }, completedByType: { $ref: "actor.type" }, completedById: { $ref: "actor.id" } },
    },
    reopen: {
      access: "write",
      guards: [{ field: "status", op: "neq", value: "pending", errorCode: "TASK_ALREADY_PENDING", message: "Task is already pending" }],
      set: { status: "pending", completedAt: null, completedByType: null, completedById: null },
    },
  },
};

const actorHasPerson = { op: "neq" as const, left: { $ref: "actor.personId" }, right: { value: null } };
const ownerIsActor = { op: "eq" as const, left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } };

export const WISH_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "wish",
  route: "wishes",
  display: { singular: "Wish", plural: "Wishes" },
  fields: {
    title: { type: "string", required: true, minLength: 1, maxLength: 100 },
    description: { type: "text", nullable: true, maxLength: 5000 },
    desiredDate: { type: "date", nullable: true },
    status: { type: "enum", required: true, values: ["open", "claimed", "fulfilled", "archived"] },
    ownerPersonId: { type: "person", required: true, immutable: true },
    claimantPersonId: { type: "person", nullable: true, readOnly: true },
    claimedAt: { type: "datetime", nullable: true, readOnly: true },
    fulfilledByPersonId: { type: "person", nullable: true, readOnly: true },
    fulfilledAt: { type: "datetime", nullable: true, readOnly: true },
    archivedFromStatus: { type: "enum", nullable: true, readOnly: true, values: ["open", "claimed", "fulfilled"] },
  },
  defaults: { status: "open" },
  query: { searchable: ["title", "description"], filterable: ["status", "ownerPersonId", "claimantPersonId", "desiredDate"], sortable: ["desiredDate", "title"] },
  access: ["read", "write"],
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  policies: {
    create: { all: [actorHasPerson, { op: "eq", left: { $ref: "input.ownerPersonId" }, right: { $ref: "actor.personId" } }] },
    read: actorHasPerson,
    update: { all: [ownerIsActor, { op: "neq", left: { $ref: "record.status" }, right: { value: "archived" } }] },
    delete: ownerIsActor,
  },
  actions: {
    claim: {
      access: "write",
      policy: { all: [actorHasPerson, { op: "neq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } }] },
      guards: [{ field: "status", op: "eq", value: "open", errorCode: "WISH_NOT_OPEN", message: "Only open wishes can be claimed" }],
      set: { status: "claimed", claimantPersonId: { $ref: "actor.personId" }, claimedAt: { $ref: "now" } },
    },
    unclaim: {
      access: "write",
      policy: { op: "eq", left: { $ref: "record.claimantPersonId" }, right: { $ref: "actor.personId" } },
      guards: [{ field: "status", op: "eq", value: "claimed", errorCode: "WISH_CLAIMANT_REQUIRED", message: "Only a claimed wish can be released" }],
      set: { status: "open", claimantPersonId: null, claimedAt: null },
    },
    fulfill: {
      access: "write",
      policy: { any: [ownerIsActor, { op: "eq", left: { $ref: "record.claimantPersonId" }, right: { $ref: "actor.personId" } }] },
      guards: [
        { field: "status", op: "neq", value: "archived", errorCode: "WISH_INVALID_STATE", message: "Wish cannot be fulfilled from its current state" },
        { field: "status", op: "neq", value: "fulfilled", errorCode: "WISH_INVALID_STATE", message: "Wish cannot be fulfilled from its current state" },
      ],
      set: { status: "fulfilled", fulfilledByPersonId: { $ref: "actor.personId" }, fulfilledAt: { $ref: "now" } },
    },
    reopen: {
      access: "write", policy: ownerIsActor,
      guards: [{ field: "status", op: "eq", value: "fulfilled", errorCode: "WISH_INVALID_STATE", message: "Only fulfilled wishes can be reopened" }],
      set: { status: "open", claimantPersonId: null, claimedAt: null, fulfilledByPersonId: null, fulfilledAt: null },
    },
    archive: {
      access: "write", policy: ownerIsActor,
      guards: [{ field: "status", op: "neq", value: "archived", errorCode: "WISH_ARCHIVED", message: "Wish is already archived" }],
      set: { archivedFromStatus: { $ref: "record.status" }, status: "archived" },
    },
    restore: {
      access: "write", policy: ownerIsActor,
      guards: [{ field: "status", op: "eq", value: "archived", errorCode: "WISH_NOT_ARCHIVED", message: "Wish is not archived" }],
      set: { status: { $ref: "record.archivedFromStatus" }, archivedFromStatus: null },
    },
  },
};

export const DAY_RECORD_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "day_record",
  route: "day-records",
  display: { singular: "Day Record", plural: "Day Records" },
  fields: {
    name: { type: "string", required: true, minLength: 1, maxLength: 100 },
    description: { type: "text", nullable: true, maxLength: 5000 },
    kind: { type: "enum", required: true, immutable: true, values: ["elapsed", "countdown", "cycle"] },
    anchorDate: { type: "date", required: true },
    subjectPersonId: { type: "person", nullable: true },
    icon: { type: "string", nullable: true, maxLength: 50 },
    attentionAfterDays: { type: "integer", nullable: true, minimum: 1 },
    attentionBeforeDays: { type: "integer", nullable: true, minimum: 0 },
    cycleDays: { type: "integer", nullable: true, minimum: 1 },
    status: { type: "enum", required: true, readOnly: true, values: ["active", "archived"] },
  },
  query: { searchable: ["name", "description"], filterable: ["kind", "status", "subjectPersonId", "anchorDate"], sortable: ["anchorDate", "name"] },
  access: ["read", "write"],
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  capabilities: {
    temporal: {
      kindField: "kind", anchorDateField: "anchorDate", cycleDaysField: "cycleDays",
      attentionBeforeDaysField: "attentionBeforeDays", attentionAfterDaysField: "attentionAfterDays",
      statusField: "status", subjectPersonField: "subjectPersonId", occurrences: true,
    },
  },
  actions: {
    archive: { access: "write", guards: [{ field: "status", op: "neq", value: "archived", errorCode: "DAY_RECORD_ARCHIVED", message: "Day record is already archived" }], set: { status: "archived" } },
    restore: { access: "write", guards: [{ field: "status", op: "neq", value: "active", errorCode: "DAY_RECORD_ALREADY_ACTIVE", message: "Day record is already active" }], set: { status: "active" } },
  },
};

export const EVENT_MODEL_DEFINITION: ModelDefinition = {
  definitionVersion: 1,
  key: "event",
  route: "events",
  display: { singular: "Event", plural: "Events" },
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
      allDayField: "isAllDay", timedStartField: "startAt", timedEndField: "endAt",
      startTimezoneField: "startTimezone", endTimezoneField: "endTimezone",
      allDayStartField: "startDate", allDayEndExclusiveField: "endDateExclusive",
      attendeePersonField: "attendeePersonIds",
    },
  },
};
