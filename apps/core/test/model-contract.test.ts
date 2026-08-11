import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION, WISH_MODEL_DEFINITION } from "../src/builtin-models";
import { generateModelContract } from "../src/model-contract";
import type { PublishedModel } from "../src/model-registry";

function published(key: "task" | "wish"): PublishedModel {
  const definition = key === "task" ? TASK_MODEL_DEFINITION : WISH_MODEL_DEFINITION;
  return {
    id: `mdl_${key}`,
    key,
    route: definition.route,
    version: 1,
    state: "published",
    schemaHash: key === "task" ? "1".repeat(64) : "2".repeat(64),
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
    expect(generatedPaths["/api/v1/spaces/{spaceId}/tasks/{recordId}/actions/complete"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/wishes/{recordId}/actions/claim"]?.post).toBeTruthy();
    expect(generatedPaths["/api/v1/spaces/{spaceId}/wishes/{recordId}/actions/restore"]?.post).toBeTruthy();
  });

  it("derives writable/create/update schemas without exposing read-only or immutable mutations", async () => {
    const snapshot = await generateModelContract([published("task"), published("wish")]);
    const generatedSchemas = schemas(snapshot);

    const taskCreate = generatedSchemas.TaskCreate as { properties: Record<string, unknown> };
    const taskUpdate = generatedSchemas.TaskUpdate as { properties: Record<string, unknown>; required: string[] };
    expect(taskCreate.properties.completedAt).toBeUndefined();
    expect(taskCreate.properties.completedByType).toBeUndefined();
    expect(taskUpdate.properties.completedAt).toBeUndefined();
    expect(taskUpdate.required).toEqual(["version"]);

    const wishUpdate = generatedSchemas.WishUpdate as { properties: Record<string, unknown> };
    expect(wishUpdate.properties.ownerPersonId).toBeUndefined();
    expect(wishUpdate.properties.claimantPersonId).toBeUndefined();
    expect(wishUpdate.properties.title).toBeTruthy();
  });

  it("derives list query parameters and JSON Schema model metadata", async () => {
    const snapshot = await generateModelContract([published("task")]);
    const taskList = paths(snapshot)["/api/v1/spaces/{spaceId}/tasks"]?.get as { parameters: Array<{ name: string; schema?: unknown }> };
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
    expect(metadata.task.actions).toEqual(["complete", "reopen"]);
  });
});
