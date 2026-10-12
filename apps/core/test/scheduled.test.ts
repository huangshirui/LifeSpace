import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { ApiError } from "../src/http";
import worker from "../src/index";

function fixture(rollingError?: Error, outboxError?: Error) {
  const queries: string[] = [];
  const prepare = vi.fn((sql: string) => {
    queries.push(sql);
    const rolling = sql.includes("FROM recurrence_plans");
    const error = rolling ? rollingError : outboxError;
    return { bind: () => ({ all: async () => {
      if (error) throw error;
      return { results: [] };
    } }) };
  });
  return { env: { DB: { prepare } } as unknown as Bindings, queries };
}

describe("Scheduled job failure isolation", () => {
  const controller = {} as ScheduledController;
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
