import { describe, expect, it } from "vitest";
import { addRecurrenceInterval, calendarOccurrences, parseRecurrenceRule, spaceRecurrenceDate } from "../src/recurrence-rule";

describe("Recurrence date contract", () => {
  it("skips missing calendar dates and keeps the firstDueDate period phase", () => {
    const rule = parseRecurrenceRule({ mode: "calendar", frequency: "monthly", interval: 1, monthDays: [31] });
    if (rule.mode !== "calendar") throw Error();
    expect(calendarOccurrences(rule, "2026-01-31", "2026-01-01", "2026-05-31", 10).dates).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    const weekly = parseRecurrenceRule({ mode: "calendar", frequency: "weekly", interval: 2, weekdays: ["MO"] });
    if (weekly.mode !== "calendar") throw Error();
    expect(calendarOccurrences(weekly, "2026-10-14", "2026-10-14", "2026-11-09", 10).dates).toEqual(["2026-10-26", "2026-11-09"]);
  });
  it("uses structured yearly dates; leap-day calendar skips while completion arithmetic clamps", () => {
    const rule = parseRecurrenceRule({ mode: "calendar", frequency: "yearly", interval: 1, dates: [{ month: 2, day: 29 }] });
    if (rule.mode !== "calendar") throw Error();
    expect(calendarOccurrences(rule, "2024-02-29", "2025-01-01", "2030-12-31", 10).dates).toEqual(["2028-02-29"]);
    expect(addRecurrenceInterval("2024-02-29", { value: 1, unit: "year" })).toBe("2025-02-28");
    expect(addRecurrenceInterval("2026-01-31", { value: 1, unit: "month" })).toBe("2026-02-28");
    expect(addRecurrenceInterval("2026-11-03", { value: 30, unit: "day" })).toBe("2026-12-03");
  });
  it("keeps windows bounded and returns a resumable next occurrence", () => {
    const rule = parseRecurrenceRule({ mode: "calendar", frequency: "daily", interval: 1 });
    if (rule.mode !== "calendar") throw Error();
    expect(calendarOccurrences(rule, "1900-01-01", "2026-10-12", "2026-12-01", 2)).toEqual({ dates: ["2026-10-12", "2026-10-13"], nextDate: "2026-10-14" });
  });
  it("interprets completion instants in the Space timezone", () => {
    expect(spaceRecurrenceDate("2026-10-12T23:30:00Z", "Asia/Shanghai")).toBe("2026-10-13");
    expect(spaceRecurrenceDate("2026-10-12T00:30:00Z", "America/Los_Angeles")).toBe("2026-10-11");
  });
  it("rejects executable/ambiguous/duplicate/out-of-bound rules", () => {
    for (const raw of [
      { mode: "calendar", frequency: "daily", interval: 0 },
      { mode: "calendar", frequency: "weekly", interval: 1, weekdays: ["MO", "MO"] },
      { mode: "calendar", frequency: "yearly", interval: 1, dates: [{ month: 2, day: 30 }] },
      { mode: "calendar", frequency: "daily", interval: 1, cron: "* * * * *" },
      { mode: "after_completion", interval: { value: 1, unit: "hour" } },
    ]) expect(() => parseRecurrenceRule(raw)).toThrow();
  });
});
