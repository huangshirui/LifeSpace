import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { ApiError } from "../src/http";
import worker from "../src/index";

function fixture(rollingError?: Error, outboxError?: Error, externalError?: Error, cleanupError?: Error) {
  const queries: string[] = [];
  const prepare = vi.fn((sql: string) => {
    queries.push(sql);
    const rolling = sql.includes("FROM recurrence_plans");
    const external = sql.includes("FROM external_models");
    const cleanup = sql.includes("FROM file_upload_sessions") || sql.includes("FROM files WHERE status='deleting'");
    const error = external ? externalError : rolling ? rollingError : cleanup ? cleanupError : outboxError;
    const all = async () => {
      if (error) throw error;
      return { results: [] };
    };
    return { all, bind: () => ({ all }) };
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

function indexOfQuery(queries: string[], fragment: string): number {
  return queries.findIndex((query) => query.includes(fragment));
}

describe("Scheduled job failure isolation", () => {
  const controller = { scheduledTime: Date.now() } as ScheduledController;
  it("dispatches Eventing before External refresh and still runs rolling and cleanup after failure", async () => {
    const error = new Error("External refresh unavailable"), f = fixture(undefined, undefined, error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBeInstanceOf(AggregateError);
    expect(indexOfQuery(f.queries, "FROM recurrence_plans")).toBeGreaterThanOrEqual(0);
    expect(indexOfQuery(f.queries, "FROM file_upload_sessions")).toBeGreaterThan(indexOfQuery(f.queries, "FROM recurrence_plans"));
    expect(indexOfQuery(f.queries, "dispatched_at IS NULL")).toBe(0);
    expect(indexOfQuery(f.queries, "FROM recurrence_plans")).toBeGreaterThan(indexOfQuery(f.queries, "dispatched_at IS NULL"));
  });
  it("retains both background failures while prioritizing outbox and cleaning uploads", async () => {
    const f = fixture(new Error("Rolling"), undefined, new Error("External"));
    await expect(worker.scheduled(controller, f.env)).rejects.toBeInstanceOf(AggregateError);
    expect(f.queries.some((query) => query.includes("FROM file_upload_sessions"))).toBe(true);
    expect(indexOfQuery(f.queries, "dispatched_at IS NULL")).toBe(0);
  });
  it("dispatches existing outbox before long-running maintenance; new recurrence events wait for next tick", async () => {
    const f = fixture();
    await worker.scheduled(controller, f.env);
    const rolling = indexOfQuery(f.queries, "FROM recurrence_plans");
    const cleanup = indexOfQuery(f.queries, "FROM file_upload_sessions");
    const outbox = indexOfQuery(f.queries, "dispatched_at IS NULL");
    expect(rolling).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(rolling);
    expect(outbox).toBe(0);
    expect(f.queries.filter((query) => query.includes("FROM file_upload_sessions"))).toHaveLength(1);
  });
  it("dispatches existing events when rolling fails and retains the failure", async () => {
    const error = new ApiError("RECURRENCE_IDENTITY_UNAVAILABLE", "Identity unavailable", 503);
    const f = fixture(error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBe(error);
    expect(f.queries.some((query) => query.includes("FROM file_upload_sessions"))).toBe(true);
    expect(indexOfQuery(f.queries, "dispatched_at IS NULL")).toBe(0);
  });
  it("reports an outbox failure once after successful rolling and cleanup", async () => {
    const error = new Error("outbox unavailable");
    const f = fixture(undefined, error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBe(error);
    expect(f.queries.filter((query) => query.includes("FROM file_upload_sessions"))).toHaveLength(1);
  });
  it("retains a file cleanup failure while still dispatching the outbox", async () => {
    const error = new Error("file cleanup unavailable");
    const f = fixture(undefined, undefined, undefined, error);
    await expect(worker.scheduled(controller, f.env)).rejects.toBe(error);
    expect(f.queries.filter((query) => query.includes("FROM file_upload_sessions"))).toHaveLength(1);
    expect(indexOfQuery(f.queries, "dispatched_at IS NULL")).toBe(0);
  });
});
