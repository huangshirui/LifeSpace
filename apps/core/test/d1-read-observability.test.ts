import { describe, expect, it, vi } from "vitest";
import { measureD1Results } from "../src/d1-batch";
import type { AuthorityD1Timing } from "../src/env";

describe("D1 binding diagnostics", () => {
  it("retains the original result and measures the existing call only", async () => {
    const result = [{success:true, results:[{id:"fixture"}], meta:{duration:2,timings:{sql_duration_ms:0.4},rows_read:3,served_by_region:"APAC",served_by_colo:"SIN"}},
      {success:true,results:[],meta:{duration:1,timings:{sql_duration_ms:0.2},rows_read:0,served_by_region:"APAC",served_by_colo:"SIN"}}] as unknown as D1Result<unknown>[];
    const operation = vi.fn(async () => result);
    const observe = vi.fn<(sample: AuthorityD1Timing) => void>();
    expect(await measureD1Results(2, operation, observe)).toBe(result);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({wallMs:expect.any(Number),statements:2,success:true,sqlDurationMs:0.6,reportedDurationMs:3,rowsRead:3,regions:["APAC"],colos:["SIN"]});
    observe.mockClear();
    const promise = Promise.resolve(result);
    expect(measureD1Results(2, () => promise)).toBe(promise);
    expect(observe).not.toHaveBeenCalled();
  });
  it("does not substitute zero for missing timing or swallow binding failures", async () => {
    const observe = vi.fn<(sample: AuthorityD1Timing) => void>();
    const result = {success:true,results:[],meta:{rows_read:0}} as unknown as D1Result<unknown>;
    expect(await measureD1Results(1, async () => result, observe)).toBe(result);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({success:true,rowsRead:0,sqlDurationMs:null,reportedDurationMs:null}));
    const error = new Error("D1 unavailable");
    await expect(measureD1Results(1, async () => {throw error;}, observe)).rejects.toBe(error);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({success:false,rowsRead:null,sqlDurationMs:null,reportedDurationMs:null}));
  });
});
