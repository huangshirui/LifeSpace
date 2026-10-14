import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { ApiError } from "../src/http";
import worker from "../src/index";

function fixture(rollingError?: Error, outboxError?: Error, externalError?: Error) {
  const queries: string[] = [];
  const prepare = vi.fn((sql: string) => {
    queries.push(sql);
    const rolling = sql.includes("FROM recurrence_plans");
    const external = sql.includes("FROM external_models");
    const error = external ? externalError : rolling ? rollingError : outboxError;
    return { bind: () => ({ all: async () => {
      if (error) throw error;
      return { results: [] };
    } }) };
  });
  const externalBinding = {
    fetch: async () => Response.json({ contractVersion: 1, data: {} }),
  } as Fetcher;
  return {
    env: {
      DB: { prepare },
      ...(externalError ? {
        EXTERNAL_PROVIDER_ROUTES: JSON.stringify({
          synthetic: {
            binding: "EXTERNAL_ADAPTER_SYNTHETIC",
            sharedSecret: "EXTERNAL_ADAPTER_SYNTHETIC_SHARED_SECRET",
          },
        }),
        EXTERNAL_ADAPTER_SYNTHETIC: externalBinding,
        EXTERNAL_ADAPTER_SYNTHETIC_SHARED_SECRET: "scheduled-synthetic-shared-secret-1234567890",
        EXTERNAL_SCHEMA_REFRESH_SECONDS: "60",
      } : {}),
    } as unknown as Bindings,
    queries,
  };
}

describe("Scheduled job failure isolation", () => {
  const controller = {} as ScheduledController;
  it("runs rolling and outbox after an External refresh failure", async () => {
    const error = new Error("External refresh unavailable"), f = fixture(undefined, undefined, error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBeInstanceOf(AggregateError);
    expect(f.queries).toHaveLength(4);
    expect(f.queries.at(-1)).toContain("dispatched_at IS NULL");
  });
  it("retains both background failures while still dispatching", async () => {
    const f = fixture(new Error("Rolling"), undefined, new Error("External"));
    await expect(worker.scheduled(controller, f.env)).rejects.toBeInstanceOf(AggregateError);
    expect(f.queries.at(-1)).toContain("dispatched_at IS NULL");
  });
  it("dispatches after rolling so newly generated events can be delivered", async () => {
    const f = fixture();
    await worker.scheduled(controller, f.env);
    expect(f.queries).toHaveLength(2);
    expect(f.queries[0]).toContain("FROM recurrence_plans");
    expect(f.queries[1]).toContain("dispatched_at IS NULL");
  });
  it("dispatches existing events when rolling fails and retains the failure", async () => {
    const error = new ApiError("RECURRENCE_IDENTITY_UNAVAILABLE", "Identity unavailable", 503);
    const f = fixture(error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBe(error);
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]).toContain("dispatched_at IS NULL");
  });
  it("reports an outbox failure after successful rolling", async () => {
    const error = new Error("outbox unavailable");
    const f = fixture(undefined, error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBe(error);
    expect(f.queries).toHaveLength(2);
  });
});
