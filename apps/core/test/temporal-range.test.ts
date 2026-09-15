import { describe, expect, it } from "vitest";
import {
  compareTemporalRange,
  validateTemporalRangeValue,
  type TemporalRangeValue,
} from "../src/temporal-range";

describe("TemporalRange value semantics", () => {
  it("accepts canonical date ranges", () => {
    expect(validateTemporalRangeValue({
      kind: "date",
      start: "2026-09-20",
      endExclusive: "2026-09-21",
    })).toEqual({
      valid: true,
      value: {
        kind: "date",
        start: "2026-09-20",
        endExclusive: "2026-09-21",
      },
    });
  });

  it("normalizes absolute instant ranges", () => {
    expect(validateTemporalRangeValue({
      kind: "instant",
      start: "2026-09-20T10:00:00+08:00",
      endExclusive: "2026-09-20T11:00:00+08:00",
    })).toEqual({
      valid: true,
      value: {
        kind: "instant",
        start: "2026-09-20T02:00:00.000Z",
        endExclusive: "2026-09-20T03:00:00.000Z",
      },
    });
  });

  it("rejects the non-canonical datetime tag and ambiguous local date-times", () => {
    expect(validateTemporalRangeValue({
      kind: "datetime",
      start: "2026-09-20T10:00:00+08:00",
      endExclusive: "2026-09-20T11:00:00+08:00",
    })).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_KIND" }),
      ]),
    });
    expect(validateTemporalRangeValue({
      kind: "instant",
      start: "2026-09-20T10:00:00",
      endExclusive: "2026-09-20T11:00:00",
    })).toEqual({
      valid: false,
      issues: [{ code: "INVALID_INSTANT", message: expect.stringContaining("absolute RFC 3339") }],
    });
  });

  it("orders instant boundaries by absolute time after normalization", () => {
    expect(validateTemporalRangeValue({
      kind: "instant",
      start: "2026-09-20T10:00:00+08:00",
      endExclusive: "2026-09-20T02:30:00Z",
    })).toMatchObject({ valid: true });
    expect(validateTemporalRangeValue({
      kind: "instant",
      start: "2026-09-20T10:00:00+08:00",
      endExclusive: "2026-09-20T01:30:00Z",
    })).toMatchObject({ valid: false, issues: [{ code: "INVALID_ORDER" }] });
  });

  it("requires an explicit projection before comparing mixed variants", () => {
    const dateRange: TemporalRangeValue = {
      kind: "date",
      start: "2026-09-20",
      endExclusive: "2026-09-21",
    };
    const instantRange: TemporalRangeValue = {
      kind: "instant",
      start: "2026-09-20T00:00:00Z",
      endExclusive: "2026-09-21T00:00:00Z",
    };
    expect(() => compareTemporalRange(dateRange, instantRange)).toThrow("explicit viewing timezone projection");
  });
});
