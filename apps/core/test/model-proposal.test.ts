import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import { diffModelDefinition } from "../src/model-proposal";
import type { PublishedModel } from "../src/model-registry";

function publishedTask(): PublishedModel {
  return {
    id: "mdl_task_test",
    key: "task",
    route: "tasks",
    version: 1,
    state: "published",
    schemaHash: "0".repeat(64),
    compatibility: "initial",
    definition: TASK_MODEL_DEFINITION,
    publishedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("Model proposal compatibility", () => {
  it("does not classify redundant lifecycle assertion changes as breaking semantics", () => {
    const { lifecycle: _lifecycle, ...withoutLifecycle } = TASK_MODEL_DEFINITION;
    const diff = diffModelDefinition(publishedTask(), withoutLifecycle);

    expect(diff.changes.some((change) => change.path === "lifecycle" && change.kind === "removed")).toBe(true);
    expect(diff.breakingReasons).not.toContain("lifecycle semantics changed");
    expect(diff.recommendedCompatibility).toBe("compatible");
  });
});
