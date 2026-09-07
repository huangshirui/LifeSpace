import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { diffModelDefinition } from "../src/model-proposal";
import type { PublishedModel } from "../src/model-registry";

function issueCodes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

function baseDefinition(key = "oracle_record"): ModelDefinition {
  return {
    definitionVersion: 1,
    key,
    route: key.replaceAll("_", "-") + "s",
    display: { singular: "Oracle Record", plural: "Oracle Records" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
      note: { type: "text", nullable: true, maxLength: 1000 },
      count: { type: "integer", minimum: 0, maximum: 100 },
      ratio: { type: "number", minimum: 0, maximum: 1 },
      enabled: { type: "boolean" },
      dueDate: { type: "date" },
      happenedAt: { type: "datetime" },
      timezone: { type: "timezone" },
      status: { type: "enum", required: true, readOnly: true, values: ["open", "closed"] },
      ownerPersonId: { type: "person", immutable: true },
      watcherPersonIds: { type: "person_list" },
      parentRecordId: { type: "record", targetModel: "oracle_parent" },
      relatedRecordIds: { type: "record_list", targetModel: "oracle_parent" },
    },
    defaults: { status: "open", watcherPersonIds: [] },
    query: {
      searchable: ["title", "note"],
      filterable: ["status", "count", "dueDate"],
      sortable: ["title", "count"],
    },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

function published(definition: ModelDefinition, version = 1): PublishedModel {
  return {
    id: `mdl_oracle_${version}`,
    key: definition.key,
    route: definition.route,
    version,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: version === 1 ? "initial" : "compatible",
    definition,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

function schema(contract: Awaited<ReturnType<typeof generateModelContract>>, name: string): Record<string, unknown> {
  return ((contract.jsonSchema.$defs as Record<string, Record<string, unknown>>)[name]);
}

function openApiPath(contract: Awaited<ReturnType<typeof generateModelContract>>, path: string): Record<string, any> {
  return (contract.openapi.paths as Record<string, Record<string, any>>)[path];
}

describe("Model Definition v1 independent Oracle fixtures", () => {
  // Oracle-Fixture: ORC-FIELD-CORE-01
  // Covers: MDV1-FIELD-TYPES-01, MDV1-FIELD-REQUIRED-NULLABLE-01, MDV1-FIELD-CONSTRAINTS-01, MDV1-RELATION-STRUCTURE-01, MDV1-DEFAULTS-01
  it("checks field vocabulary, constraints, relation structure and defaults from handwritten expectations", () => {
    const definition = baseDefinition();
    const valid = validateModelDefinition(definition);
    expect(valid.valid).toBe(true);
    if (!valid.valid) return;
    expect(Object.values(valid.definition.fields).map((field) => field.type)).toEqual([
      "string", "text", "integer", "number", "boolean", "date", "datetime", "timezone",
      "enum", "person", "person_list", "record", "record_list",
    ]);
    expect(valid.definition.defaults).toEqual({ status: "open", watcherPersonIds: [] });
    expect(valid.definition.fields.parentRecordId.targetModel).toBe("oracle_parent");

    const requiredNullable = structuredClone(definition) as any;
    requiredNullable.fields.title.nullable = true;
    expect(issueCodes(requiredNullable)).toContain("CONTRADICTORY_NULLABILITY");

    const wrongConstraint = structuredClone(definition) as any;
    wrongConstraint.fields.enabled.minLength = 1;
    expect(issueCodes(wrongConstraint)).toContain("INVALID_CONSTRAINT");

    const missingTarget = structuredClone(definition) as any;
    delete missingTarget.fields.parentRecordId.targetModel;
    expect(issueCodes(missingTarget)).toContain("TARGET_MODEL_REQUIRED");

    const fixedPersonDefault = structuredClone(definition) as any;
    fixedPersonDefault.defaults.ownerPersonId = "per_fixed";
    expect(issueCodes(fixedPersonDefault)).toContain("INVALID_DEFAULT");

    const unsupportedType = structuredClone(definition) as any;
    unsupportedType.fields.title.type = "money";
    expect(issueCodes(unsupportedType)).toContain("UNSUPPORTED_FIELD_TYPE");
  });

  // Oracle-Fixture: ORC-CONTRACT-MUTATION-01
  // Covers: MDV1-FIELD-IMMUTABLE-01, MDV1-FIELD-READONLY-01, MDV1-QUERY-GENERIC-01, MDV1-ACCESS-HIERARCHY-01, MDV1-LIFECYCLE-INVARIANTS-01
  it("checks mutation authority, immutable fields, generic query shape, access hierarchy and concurrency contract", async () => {
    const definition = baseDefinition();
    const contract = await generateModelContract([published(definition)]);
    const create = schema(contract, "OracleRecordCreate") as any;
    const update = schema(contract, "OracleRecordUpdate") as any;
    const resource = schema(contract, "OracleRecordResource") as any;

    expect(create.properties.status).toBeUndefined();
    expect(create.properties.ownerPersonId).toBeTruthy();
    expect(update.properties.status).toBeUndefined();
    expect(update.properties.ownerPersonId).toBeUndefined();
    expect(update.required).toEqual(["version"]);
    expect(update.properties.version["x-lifespace-input-role"]).toBe("concurrency");
    expect(resource.properties.status.readOnly).toBe(true);

    const collection = openApiPath(contract, "/api/v1/spaces/{spaceId}/oracle-records");
    const parameterNames = collection.get.parameters.map((parameter: any) => parameter.name);
    expect(parameterNames).toEqual(expect.arrayContaining([
      "q", "status", "count", "countFrom", "countTo", "dueDate", "dueDateFrom", "dueDateTo", "sort", "limit", "cursor",
    ]));
    const sort = collection.get.parameters.find((parameter: any) => parameter.name === "sort");
    expect(sort.explode).toBe(true);
    expect(sort.schema.maxItems).toBe(8);

    expect(issueCodes({ ...definition, access: ["write"] })).toContain("INVALID_ACCESS");
    expect(issueCodes({ ...definition, lifecycle: { optimisticConcurrency: false, softDelete: true } })).toContain("UNSUPPORTED_LIFECYCLE_OVERRIDE");
  });

  // Oracle-Fixture: ORC-POLICY-BOUNDARY-01
  // Covers: MDV1-POLICY-BOUNDARY-01
  it("checks Policy reference/operator boundaries independently of a shipped business model", () => {
    const definition = baseDefinition("oracle_policy");
    definition.policies = {
      create: { op: "eq", left: { $ref: "input.ownerPersonId" }, right: { $ref: "actor.personId" } },
      read: { op: "neq", left: { $ref: "actor.personId" }, right: { value: null } },
      update: { op: "eq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } },
      delete: { op: "eq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } },
    };
    expect(validateModelDefinition(definition).valid).toBe(true);

    const recordAwareRead = structuredClone(definition) as any;
    recordAwareRead.policies.read = { op: "eq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } };
    expect(issueCodes(recordAwareRead)).toContain("POLICY_RECORD_REFERENCE_NOT_ALLOWED");

    const inputDelete = structuredClone(definition) as any;
    inputDelete.policies.delete = { op: "eq", left: { $ref: "input.ownerPersonId" }, right: { $ref: "actor.personId" } };
    expect(issueCodes(inputDelete)).toContain("POLICY_INPUT_REFERENCE_NOT_ALLOWED");

    const arbitraryReference = structuredClone(definition) as any;
    arbitraryReference.policies.create = { op: "eq", left: { $ref: "system.secret" }, right: { value: "x" } };
    expect(issueCodes(arbitraryReference)).toContain("INVALID_POLICY_REFERENCE");
  });

  // Oracle-Fixture: ORC-ACTION-SEMANTICS-01
  // Covers: MDV1-ACTION-ACCESS-01, MDV1-ACTION-CONCURRENCY-01, MDV1-ACTION-TRANSITION-01, MDV1-ACTOR-REFERENCES-01
  it("checks bounded Action semantics and keeps semantic input separate from concurrency evidence", async () => {
    const definition = baseDefinition("oracle_action");
    definition.fields.changedAt = { type: "datetime", nullable: true, readOnly: true };
    definition.fields.changedByType = { type: "enum", nullable: true, readOnly: true, values: ["user", "service", "device", "agent"] };
    definition.fields.changedById = { type: "string", nullable: true, readOnly: true };
    definition.actions = {
      close: {
        access: "write",
        guards: [{ field: "status", op: "neq", value: "closed", errorCode: "ALREADY_CLOSED", message: "Already closed" }],
        branches: [{ when: { field: "status", op: "eq", value: "open" }, set: { status: "closed" } }],
        set: {
          status: "closed",
          changedAt: { $ref: "now" },
          changedByType: { $ref: "actor.type" },
          changedById: { $ref: "actor.id" },
        },
      },
    };
    expect(validateModelDefinition(definition).valid).toBe(true);

    const contract = await generateModelContract([published(definition)]);
    const actionPath = openApiPath(contract, "/api/v1/spaces/{spaceId}/oracle-actions/{recordId}/actions/close");
    expect(actionPath.post["x-lifespace-concurrency"]).toEqual({
      strategy: "record-version",
      required: true,
      transport: { in: "body", name: "version" },
    });
    expect(actionPath.post.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/OracleActionVersionRequest");

    const inaccessible = structuredClone(definition) as any;
    inaccessible.access = ["read"];
    expect(issueCodes(inaccessible)).toContain("ACTION_ACCESS_NOT_EXPOSED");

    const incompleteActorVocabulary = structuredClone(definition) as any;
    incompleteActorVocabulary.fields.changedByType.values = ["user", "service", "device"];
    expect(issueCodes(incompleteActorVocabulary)).toContain("INCOMPATIBLE_ACTION_REFERENCE");

    const immutableAssignment = structuredClone(definition) as any;
    immutableAssignment.actions.close.set.ownerPersonId = { $ref: "actor.personId" };
    expect(issueCodes(immutableAssignment)).toContain("IMMUTABLE_ACTION_FIELD");
  });

  // Oracle-Fixture: ORC-CAPABILITY-TEMPORAL-01
  // Covers: MDV1-CAPABILITY-TEMPORAL-01
  it("checks Temporal field-role and occurrence semantics from a handwritten capability model", async () => {
    const definition: ModelDefinition = {
      definitionVersion: 1,
      key: "oracle_temporal",
      route: "oracle-temporals",
      display: { singular: "Temporal Oracle", plural: "Temporal Oracles" },
      fields: {
        name: { type: "string", required: true },
        kind: { type: "enum", required: true, values: ["elapsed", "countdown", "cycle"] },
        anchorDate: { type: "date", required: true },
        cycleDays: { type: "integer", nullable: true },
        attentionBeforeDays: { type: "integer", required: true },
        attentionAfterDays: { type: "integer", required: true },
        status: { type: "enum", required: true, values: ["active", "archived"] },
        subjectPersonId: { type: "person", nullable: true },
      },
      defaults: { status: "active", attentionBeforeDays: 0, attentionAfterDays: 0 },
      access: ["read", "write"],
      capabilities: { temporal: {
        kindField: "kind",
        anchorDateField: "anchorDate",
        cycleDaysField: "cycleDays",
        attentionBeforeDaysField: "attentionBeforeDays",
        attentionAfterDaysField: "attentionAfterDays",
        statusField: "status",
        subjectPersonField: "subjectPersonId",
        occurrences: true,
      } },
    };
    expect(validateModelDefinition(definition).valid).toBe(true);
    const contract = await generateModelContract([published(definition)]);
    const resource = schema(contract, "OracleTemporalResource") as any;
    expect(resource.properties.computed.properties.temporal.required).toEqual(["today", "state", "attentionLevel", "isAttentionRequired"]);
    const occurrence = openApiPath(contract, "/api/v1/spaces/{spaceId}/oracle-temporals/{recordId}/actions/record-occurrence");
    expect(occurrence.post["x-lifespace-concurrency"].strategy).toBe("record-version");

    const wrongMapping = structuredClone(definition) as any;
    wrongMapping.capabilities.temporal.anchorDateField = "name";
    expect(issueCodes(wrongMapping)).toContain("INVALID_CAPABILITY_FIELD_TYPE");
  });

  // Oracle-Fixture: ORC-CAPABILITY-CALENDAR-01
  // Covers: MDV1-CAPABILITY-CALENDAR-01
  it("checks Calendar timed/all-day bindings and semantic query inputs", async () => {
    const definition: ModelDefinition = {
      definitionVersion: 1,
      key: "oracle_calendar",
      route: "oracle-calendars",
      display: { singular: "Calendar Oracle", plural: "Calendar Oracles" },
      fields: {
        title: { type: "string", required: true },
        allDay: { type: "boolean", required: true },
        startAt: { type: "datetime", nullable: true },
        endAt: { type: "datetime", nullable: true },
        startTimezone: { type: "timezone", nullable: true },
        endTimezone: { type: "timezone", nullable: true },
        startDate: { type: "date", nullable: true },
        endDateExclusive: { type: "date", nullable: true },
        attendeePersonIds: { type: "person_list" },
      },
      defaults: { attendeePersonIds: [] },
      access: ["read", "write"],
      capabilities: { calendar: {
        allDayField: "allDay",
        timedStartField: "startAt",
        timedEndField: "endAt",
        startTimezoneField: "startTimezone",
        endTimezoneField: "endTimezone",
        allDayStartField: "startDate",
        allDayEndExclusiveField: "endDateExclusive",
        attendeePersonField: "attendeePersonIds",
      } },
    };
    expect(validateModelDefinition(definition).valid).toBe(true);
    const contract = await generateModelContract([published(definition)]);
    const collection = openApiPath(contract, "/api/v1/spaces/{spaceId}/oracle-calendars");
    const names = collection.get.parameters.map((parameter: any) => parameter.name);
    expect(names).toEqual(expect.arrayContaining(["rangeStart", "rangeEnd", "dateStart", "dateEndExclusive", "sort"]));
    const create = schema(contract, "OracleCalendarCreate") as any;
    expect(create.allOf[0]["x-lifespace-range-semantics"]).toContain("half-open");

    const duplicateBinding = structuredClone(definition) as any;
    duplicateBinding.capabilities.calendar.timedEndField = "startAt";
    expect(issueCodes(duplicateBinding)).toContain("DUPLICATE_CAPABILITY_FIELD");
  });

  // Oracle-Fixture: ORC-PUBLICATION-COMPATIBILITY-01
  // Covers: MDV1-PUBLICATION-COMPATIBILITY-01
  it("checks compatible addition versus breaking existing-field change using explicit expectations", () => {
    const base = baseDefinition("oracle_compatibility");
    const additive: ModelDefinition = structuredClone(base);
    additive.fields.optionalFlag = { type: "boolean" };
    expect(diffModelDefinition(published(base), additive).recommendedCompatibility).toBe("compatible");

    const breaking: ModelDefinition = structuredClone(base);
    breaking.fields.title = { ...breaking.fields.title, maxLength: 40 };
    const diff = diffModelDefinition(published(base), breaking);
    expect(diff.recommendedCompatibility).toBe("breaking");
    expect(diff.breakingReasons).toContain("field title constraints/type/behavior changed");
  });
});
