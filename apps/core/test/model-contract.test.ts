import { describe, expect, it } from "vitest";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
} from "../src/builtin-models";
import { generateModelContract } from "../src/model-contract";
import type { PublishedModel } from "../src/model-registry";

const definitions = {
  task: TASK_MODEL_DEFINITION,
  wish: WISH_MODEL_DEFINITION,
  day_record: DAY_RECORD_MODEL_DEFINITION,
  event: EVENT_MODEL_DEFINITION,
} as const;

type Key = keyof typeof definitions;

type SortSchema = {
  type?: string;
  minItems?: number;
  maxItems?: number;
  default?: string[];
  items?: { enum?: string[] };
  oneOf?: Array<{
    type?: string;
    enum?: string[];
    minItems?: number;
    maxItems?: number;
    default?: string[];
    items?: { enum?: string[] };
  }>;
  "x-lifespace-defaults"?: Record<string, unknown>;
};

function published(key: Key): PublishedModel {
  const definition = definitions[key];
  return {
    id: `mdl_${key}`,
    key,
    route: definition.route,
    version: key === "task" || key === "wish" ? 5 : key === "event" ? 3 : 2,
    state: "published",
    schemaHash: ({ task: "1", wish: "2", day_record: "3", event: "4" } as const)[key].repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-08-11T00:00:00.000Z",
  };
}

function schemas(snapshot: Awaited<ReturnType<typeof generateModelContract>>) {
  return (snapshot.openapi.components as { schemas: Record<string, Record<string, unknown>> }).schemas;
}

function paths(snapshot: Awaited<ReturnType<typeof generateModelContract>>) {
  return snapshot.openapi.paths as Record<string, Record<string, unknown>>;
}

function sortParameter(snapshot: Awaited<ReturnType<typeof generateModelContract>>, path: string) {
  const list = paths(snapshot)[path]?.get as {
    parameters: Array<{
      name: string;
      style?: string;
      explode?: boolean;
      description?: string;
      schema?: SortSchema;
    }>;
  };
  return list.parameters.find((parameter) => parameter.name === "sort");
}

const concurrency = {
  strategy: "record-version",
  required: true,
  transport: { in: "body", name: "version" },
};

describe("Model Contract Generator", () => {
  it("is deterministic regardless of registry row order", async () => {
    const task = published("task");
    const wish = published("wish");
    const left = await generateModelContract([task, wish]);
    const right = await generateModelContract([wish, task]);

    expect(left.id).toMatch(/^mct_[a-f0-9]{64}$/);
    expect(left.hash).toHaveLength(64);
    expect(left).toEqual(right);
    expect(left.manifest.models.map((model) => model.key)).toEqual(["task", "wish"]);
  });

  it("generates concrete CRUD/action paths from model metadata", async () => {
    const snapshot = await generateModelContract([published("task"), published("wish")]);
    const generatedPaths = paths(snapshot);

    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks"]?.get).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks/{recordId}"]?.patch).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks/{recordId}/actions/cancel"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks/{recordId}/actions/complete"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/wishes/{recordId}/actions/fulfill"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/wishes/{recordId}/actions/reopen"]?.post).toBeTruthy();
  });

  it("projects canonical field title/description metadata into OpenAPI and JSON Schema 2020-12", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const taskCreate = schemas(snapshot).TaskCreate as {
      properties: Record<string, { title?: string; description?: string }>;
    };
    const taskResource = schemas(snapshot).TaskResource as {
      properties: Record<string, { title?: string; description?: string }>;
    };
    expect(taskCreate.properties.name).toMatchObject({
      title: "Name",
      description: "The concrete action or to-do to complete.",
    });
    expect(taskResource.properties.assigneePersonIds).toMatchObject({
      title: "Assignees",
      description: "People responsible for completing the task.",
    });
    expect(snapshot.jsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const defs = snapshot.jsonSchema.$defs as Record<string, { properties: Record<string, { title?: string }> }>;
    expect(defs.TaskResource.properties.dueDate.title).toBe("Due Date");
  });

  it("marks record version as technical concurrency metadata instead of Action semantic input", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const generatedPaths = paths(snapshot);
    const complete = generatedPaths["/api/v1/spaces/{spaceId}/tasks/{recordId}/actions/complete"]?.post as {
      requestBody: { content: { "application/json": { schema: { $ref: string } } } };
      "x-lifespace-concurrency": unknown;
    };
    expect(complete["x-lifespace-concurrency"]).toEqual(concurrency);
    expect(complete.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/TaskVersionRequest");

    const versionRequest = schemas(snapshot).TaskVersionRequest as {
      properties: { version: Record<string, unknown> };
      required: string[];
    };
    expect(versionRequest.required).toEqual(["version"]);
    expect(versionRequest.properties.version).toMatchObject({
      type: "integer",
      minimum: 1,
      "x-lifespace-input-role": "concurrency",
    });
  });

  it("keeps read-only server defaults out of the writable create schema", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const taskCreate = schemas(snapshot).TaskCreate as {
      properties: Record<string, { default?: unknown }>;
      required: string[];
    };

    expect(taskCreate.properties.status).toBeUndefined();
    expect(taskCreate.required).toContain("name");
    expect(taskCreate.required).not.toContain("status");
  });

  it("publishes the full Actor vocabulary for Task completion attribution", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const resource = schemas(snapshot).TaskResource as {
      properties: { completedByType: { anyOf?: Array<{ enum?: string[] }> } };
    };
    const enumValues = resource.properties.completedByType.anyOf
      ?.find((schema) => Array.isArray(schema.enum))?.enum;
    expect(enumValues).toEqual(["user", "service", "device", "agent"]);
  });

  it("derives writable/create/update schemas without exposing read-only or immutable mutations", async () => {
    const snapshot = await generateModelContract([published("task"), published("wish")]);
    const generatedSchemas = schemas(snapshot);

    const taskCreate = generatedSchemas.TaskCreate as { properties: Record<string, unknown> };
    const taskUpdate = generatedSchemas.TaskUpdate as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(taskCreate.properties.status).toBeUndefined();
    expect(taskCreate.properties.completedAt).toBeUndefined();
    expect(taskCreate.properties.completedByType).toBeUndefined();
    expect(taskUpdate.properties.status).toBeUndefined();
    expect(taskUpdate.properties.completedAt).toBeUndefined();
    expect(taskUpdate.required).toEqual(["version"]);
    expect(taskUpdate.properties.version["x-lifespace-input-role"]).toBe("concurrency");

    const wishCreate = generatedSchemas.WishCreate as { properties: Record<string, unknown> };
    const wishUpdate = generatedSchemas.WishUpdate as { properties: Record<string, unknown> };
    expect(wishCreate.properties.status).toBeUndefined();
    expect(wishUpdate.properties.status).toBeUndefined();
    expect(wishUpdate.properties.ownerPersonId).toBeUndefined();
    expect(wishUpdate.properties.fulfilledAt).toBeUndefined();
    expect(wishUpdate.properties.title).toBeTruthy();
  });

  it("describes repeatable ordered generic sort parameters", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const sort = sortParameter(snapshot, "/api/v1/spaces/{spaceId}/tasks");
    expect(sort?.style).toBe("form");
    expect(sort?.explode).toBe(true);
    expect(sort?.schema).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
      default: ["createdAt:desc"],
    });
    expect(sort?.schema?.items?.enum).toEqual(expect.arrayContaining([
      "createdAt:asc",
      "updatedAt:desc",
      "dueDate:asc",
      "name:desc",
    ]));
  });

  it("contributes Temporal computed/query/occurrence contracts with semantic input distinct from concurrency", async () => {
    const snapshot = await generateModelContract([published("day_record")]);
    const generatedPaths = paths(snapshot);
    const generatedSchemas = schemas(snapshot);
    const list = generatedPaths["/api/v1/spaces/{spaceId}/day-records"]?.get as {
      parameters: Array<{ name: string }>;
    };
    const names = list.parameters.map((parameter) => parameter.name);
    const sort = sortParameter(snapshot, "/api/v1/spaces/{spaceId}/day-records")?.schema;
    const semanticSort = sort?.oneOf?.find((branch) => branch.type === "string");
    const genericSort = sort?.oneOf?.find((branch) => branch.type === "array");

    expect(names).toContain("attentionOnly");
    expect(semanticSort?.enum).toEqual(expect.arrayContaining(["attention:desc", "effectiveDate:asc"]));
    expect(genericSort?.items?.enum).toContain("anchorDate:asc");
    expect(sort?.["x-lifespace-defaults"]).toMatchObject({
      generic: ["createdAt:desc"],
      temporal: "effectiveDate:asc",
    });
    expect(generatedPaths["/api/v1/spaces/{spaceId}/day-records/{recordId}/occurrences"]?.get).toBeTruthy();
    const occurrenceAction = generatedPaths["/api/v1/spaces/{spaceId}/day-records/{recordId}/actions/record-occurrence"]?.post as {
      "x-lifespace-concurrency": unknown;
    };
    expect(occurrenceAction["x-lifespace-concurrency"]).toEqual(concurrency);

    const occurrenceRequest = generatedSchemas.DayRecordRecordOccurrenceRequest as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(occurrenceRequest.properties.version["x-lifespace-input-role"]).toBe("concurrency");
    expect(occurrenceRequest.properties.occurredOn["x-lifespace-input-role"]).toBeUndefined();
    expect(occurrenceRequest.properties.note["x-lifespace-input-role"]).toBeUndefined();

    const resource = generatedSchemas.DayRecordResource as {
      properties: { computed?: { properties?: { temporal?: unknown } } };
    };
    expect(resource.properties.computed?.properties?.temporal).toBeTruthy();

    const metadata = snapshot.jsonSchema["x-lifespace-models"] as Record<string, { actions: string[]; capabilities: string[] }>;
    expect(metadata.day_record.actions).toContain("record-occurrence");
    expect(metadata.day_record.capabilities).toContain("temporal");
  });

  it("contributes Calendar mode and dual-window query contracts", async () => {
    const snapshot = await generateModelContract([published("event")]);
    const generatedPaths = paths(snapshot);
    const generatedSchemas = schemas(snapshot);
    const list = generatedPaths["/api/v1/spaces/{spaceId}/events"]?.get as {
      parameters: Array<{ name: string }>;
    };
    const names = list.parameters.map((parameter) => parameter.name);
    const sort = sortParameter(snapshot, "/api/v1/spaces/{spaceId}/events")?.schema;
    const semanticSort = sort?.oneOf?.find((branch) => branch.type === "string");
    const genericSort = sort?.oneOf?.find((branch) => branch.type === "array");

    expect(names).toEqual(expect.arrayContaining(["rangeStart", "rangeEnd", "dateStart", "dateEndExclusive"]));
    expect(semanticSort?.enum).toEqual(expect.arrayContaining(["calendarStart:asc", "calendarStart:desc"]));
    expect(genericSort?.items?.enum).toEqual(expect.arrayContaining(["startAt:asc", "summary:desc"]));
    expect(sort?.["x-lifespace-defaults"]).toMatchObject({
      generic: ["createdAt:desc"],
      calendar: "calendarStart:asc",
    });

    const create = generatedSchemas.EventCreate as { allOf?: Array<{ oneOf?: unknown[] }> };
    expect(create.allOf?.[0]?.oneOf).toHaveLength(2);

    const metadata = snapshot.jsonSchema["x-lifespace-models"] as Record<string, { capabilities: string[] }>;
    expect(metadata.event.capabilities).toContain("calendar");
  });

  it("derives list query parameters and JSON Schema model metadata", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const taskList = paths(snapshot)["/api/v1/spaces/{spaceId}/tasks"]?.get as {
      parameters: Array<{ name: string; schema?: unknown }>;
    };
    const names = taskList.parameters.map((parameter) => parameter.name);
    expect(names).toContain("q");
    expect(names).toContain("status");
    expect(names).toContain("dueDateFrom");
    expect(names).toContain("dueDateTo");
    expect(names).toContain("assigneePersonIds");
    expect(names).toContain("sort");
    expect(names).toContain("cursor");

    const metadata = snapshot.jsonSchema["x-lifespace-models"] as Record<string, { route: string; actions: string[] }>;
    expect(metadata.task.route).toBe("tasks");
    expect(metadata.task.actions).toEqual(["cancel", "complete", "reopen"]);
  });
});
