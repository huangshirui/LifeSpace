import { describe, expect, it } from "vitest";
import { prepareCalendarUpdate } from "../src/calendar-capability";
import type { GenericResource } from "../src/generic-resource";
import type { PublishedModel } from "../src/model-registry";

const model = {
  id: "mdl_event_test",
  key: "event",
  version: 1,
  state: "published",
  schemaHash: "test",
  compatibility: "initial",
  publishedAt: "2026-09-09T00:00:00.000Z",
  definition: {
    capabilities: {
      calendar: {
        allDayField: "isAllDay",
        timedStartField: "startAt",
        timedEndField: "endAt",
        startTimezoneField: "startTimezone",
        endTimezoneField: "endTimezone",
        allDayStartField: "startDate",
        allDayEndExclusiveField: "endDateExclusive",
      },
    },
  },
} as PublishedModel;

function resource(data: Record<string, unknown>): GenericResource {
  return {
    id: "rec_event_test",
    spaceId: "spc_event_test",
    modelKey: "event",
    modelVersion: 1,
    data,
    version: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("Calendar capability updates", () => {
  it("switches an all-day resource to timed and clears inherited all-day dates", () => {
    const current = resource({
      isAllDay: true,
      startDate: "2026-09-12",
      endDateExclusive: "2026-09-14",
      startAt: null,
      endAt: null,
      startTimezone: null,
      endTimezone: null,
    });

    expect(prepareCalendarUpdate(model, current, {
      isAllDay: false,
      startAt: "2026-09-12T02:00:00.000Z",
      endAt: "2026-09-12T04:00:00.000Z",
      startTimezone: "Asia/Shanghai",
      endTimezone: "Asia/Shanghai",
    })).toEqual({
      isAllDay: false,
      startDate: null,
      endDateExclusive: null,
      startAt: "2026-09-12T02:00:00.000Z",
      endAt: "2026-09-12T04:00:00.000Z",
      startTimezone: "Asia/Shanghai",
      endTimezone: "Asia/Shanghai",
    });
  });

  it("switches a timed resource to all-day and clears inherited timed fields", () => {
    const current = resource({
      isAllDay: false,
      startAt: "2026-09-12T02:00:00.000Z",
      endAt: "2026-09-12T04:00:00.000Z",
      startTimezone: "Asia/Shanghai",
      endTimezone: "Asia/Shanghai",
      startDate: null,
      endDateExclusive: null,
    });

    expect(prepareCalendarUpdate(model, current, {
      isAllDay: true,
      startDate: "2026-09-12",
      endDateExclusive: "2026-09-14",
    })).toEqual({
      isAllDay: true,
      startAt: null,
      endAt: null,
      startTimezone: null,
      endTimezone: null,
      startDate: "2026-09-12",
      endDateExclusive: "2026-09-14",
    });
  });

  it("still rejects conflicting opposite-mode fields when the mode does not change", () => {
    const current = resource({
      isAllDay: false,
      startAt: "2026-09-12T02:00:00.000Z",
      endAt: "2026-09-12T04:00:00.000Z",
      startTimezone: "Asia/Shanghai",
      endTimezone: "Asia/Shanghai",
      startDate: null,
      endDateExclusive: null,
    });

    expect(() => prepareCalendarUpdate(model, current, {
      startDate: "2026-09-12",
    })).toThrowError("Timed Calendar resources cannot contain all-day dates");
  });
});
