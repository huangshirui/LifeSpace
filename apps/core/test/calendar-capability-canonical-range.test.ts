import { describe, expect, it } from "vitest";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";

function canonicalDefinition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "canonical_calendar_oracle",
    display: { singular: "Calendar Oracle", plural: "Calendar Oracles" },
    fields: {
      title: { type: "string", required: true },
      when: { type: "temporal_range", required: true },
      attendeePersonIds: { type: "person_list" },
    },
    access: ["read", "write"],
    capabilities: {
      calendar: {
        rangeField: "when",
        attendeePersonField: "attendeePersonIds",
      },
    },
  };
}

function issueCodes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("canonical Calendar temporal_range binding", () => {
  it("accepts one temporal_range field as the Calendar time truth", () => {
    const result = validateModelDefinition(canonicalDefinition());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.capabilities?.calendar).toEqual({
      rangeField: "when",
      attendeePersonField: "attendeePersonIds",
    });
  });

  it("rejects rangeField when it does not reference temporal_range", () => {
    const definition = canonicalDefinition() as any;
    definition.fields.when = { type: "datetime", required: true };
    expect(issueCodes(definition)).toContain("INVALID_CAPABILITY_FIELD_TYPE");
  });

  it("rejects mixing canonical and legacy Calendar bindings", () => {
    const definition = canonicalDefinition() as any;
    Object.assign(definition.fields, {
      allDay: { type: "boolean", required: true },
      startAt: { type: "datetime", nullable: true },
      endAt: { type: "datetime", nullable: true },
      startTimezone: { type: "timezone", nullable: true },
      endTimezone: { type: "timezone", nullable: true },
      startDate: { type: "date", nullable: true },
      endDateExclusive: { type: "date", nullable: true },
    });
    Object.assign(definition.capabilities.calendar, {
      allDayField: "allDay",
      timedStartField: "startAt",
      timedEndField: "endAt",
      startTimezoneField: "startTimezone",
      endTimezoneField: "endTimezone",
      allDayStartField: "startDate",
      allDayEndExclusiveField: "endDateExclusive",
    });
    expect(issueCodes(definition)).toContain("MIXED_CALENDAR_BINDING");
  });

  it("keeps the historical split-field Calendar binding valid", () => {
    const definition: ModelDefinition = {
      definitionVersion: 1,
      key: "legacy_calendar_oracle",
      display: { singular: "Legacy Calendar", plural: "Legacy Calendars" },
      fields: {
        allDay: { type: "boolean", required: true },
        startAt: { type: "datetime", nullable: true },
        endAt: { type: "datetime", nullable: true },
        startTimezone: { type: "timezone", nullable: true },
        endTimezone: { type: "timezone", nullable: true },
        startDate: { type: "date", nullable: true },
        endDateExclusive: { type: "date", nullable: true },
      },
      access: ["read", "write"],
      capabilities: {
        calendar: {
          allDayField: "allDay",
          timedStartField: "startAt",
          timedEndField: "endAt",
          startTimezoneField: "startTimezone",
          endTimezoneField: "endTimezone",
          allDayStartField: "startDate",
          allDayEndExclusiveField: "endDateExclusive",
        },
      },
    };
    expect(validateModelDefinition(definition).valid).toBe(true);
  });
});
