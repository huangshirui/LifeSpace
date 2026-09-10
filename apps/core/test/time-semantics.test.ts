import { describe, expect, it } from "vitest";
import { assertIanaTimezone, localDateWindowToInstantRange } from "../src/time-semantics";

function durationHours(startInclusive: string, endExclusive: string): number {
  return (Date.parse(endExclusive) - Date.parse(startInclusive)) / 3_600_000;
}

describe("Time Semantics", () => {
  it("converts an ordinary Shanghai local date window to an instant range", () => {
    expect(localDateWindowToInstantRange({
      dateStart: "2026-09-10",
      dateEndExclusive: "2026-09-11",
      timezone: "Asia/Shanghai",
    })).toEqual({
      startInclusive: "2026-09-09T16:00:00.000Z",
      endExclusive: "2026-09-10T16:00:00.000Z",
    });
  });

  it("resolves spring-forward boundaries independently instead of assuming 24 hours", () => {
    const range = localDateWindowToInstantRange({
      dateStart: "2026-03-08",
      dateEndExclusive: "2026-03-09",
      timezone: "America/New_York",
    });
    expect(range).toEqual({
      startInclusive: "2026-03-08T05:00:00.000Z",
      endExclusive: "2026-03-09T04:00:00.000Z",
    });
    expect(durationHours(range.startInclusive, range.endExclusive)).toBe(23);
  });

  it("resolves fall-back boundaries independently and permits a 25-hour local day", () => {
    const range = localDateWindowToInstantRange({
      dateStart: "2026-11-01",
      dateEndExclusive: "2026-11-02",
      timezone: "America/New_York",
    });
    expect(range).toEqual({
      startInclusive: "2026-11-01T04:00:00.000Z",
      endExclusive: "2026-11-02T05:00:00.000Z",
    });
    expect(durationHours(range.startInclusive, range.endExclusive)).toBe(25);
  });

  it("supports non-whole-hour IANA offsets", () => {
    expect(localDateWindowToInstantRange({
      dateStart: "2026-09-10",
      dateEndExclusive: "2026-09-11",
      timezone: "Asia/Kathmandu",
    })).toEqual({
      startInclusive: "2026-09-09T18:15:00.000Z",
      endExclusive: "2026-09-10T18:15:00.000Z",
    });
  });

  it("uses historical IANA offset data", () => {
    expect(localDateWindowToInstantRange({
      dateStart: "2011-12-31",
      dateEndExclusive: "2012-01-01",
      timezone: "Pacific/Apia",
    })).toEqual({
      startInclusive: "2011-12-30T10:00:00.000Z",
      endExclusive: "2011-12-31T10:00:00.000Z",
    });
  });

  it("rejects a local calendar date skipped by a historical timezone change", () => {
    expect(() => localDateWindowToInstantRange({
      dateStart: "2011-12-30",
      dateEndExclusive: "2011-12-31",
      timezone: "Pacific/Apia",
    })).toThrow("dateStart does not exist in timezone Pacific/Apia");
  });

  it("rejects invalid dates, reversed windows and invalid timezones", () => {
    expect(() => localDateWindowToInstantRange({
      dateStart: "2026-02-30",
      dateEndExclusive: "2026-03-01",
      timezone: "UTC",
    })).toThrow("dateStart must be a valid calendar date");
    expect(() => localDateWindowToInstantRange({
      dateStart: "2026-09-10",
      dateEndExclusive: "2026-09-10",
      timezone: "UTC",
    })).toThrow("dateEndExclusive must be later than dateStart");
    expect(() => assertIanaTimezone("Mars/Olympus_Mons")).toThrow("timezone must be an IANA timezone");
  });
});
