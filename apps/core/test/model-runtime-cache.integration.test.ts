import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import {
  getRuntimeModel,
  getRuntimeModelByRoute,
  invalidateRuntimeModelRegistry,
} from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

describe("Runtime Model Registry cache", () => {
  it("reuses one compiled descriptor snapshot for hot route/key lookups", async () => {
    const runtimeEnv = bindings();
    invalidateRuntimeModelRegistry(runtimeEnv);

    const byRoute = await getRuntimeModelByRoute(runtimeEnv, "tasks");
    expect(byRoute?.key).toBe("task");
    expect(byRoute?.runtime.filterable).toContain("status");
    expect(byRoute?.runtime.allowedQueryKeys.has("dueDateFrom")).toBe(true);
    expect(byRoute?.runtime.relationFields).toContain("assigneePersonIds");

    const byKey = await getRuntimeModel(runtimeEnv, "task");
    expect(byKey).toBe(byRoute);
  });

  it("reloads descriptors after explicit invalidation", async () => {
    const runtimeEnv = bindings();
    invalidateRuntimeModelRegistry(runtimeEnv);

    const first = await getRuntimeModelByRoute(runtimeEnv, "tasks");
    expect(first).not.toBeNull();

    invalidateRuntimeModelRegistry(runtimeEnv);
    const second = await getRuntimeModelByRoute(runtimeEnv, "tasks");

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.schemaHash).toBe(first?.schemaHash);
  });
});
