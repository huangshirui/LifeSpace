import { describe, expect, it } from "vitest";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
} from "../src/builtin-models";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";
import { creationDraftModelDescriptors } from "../src/registry-creation-draft";

function published(definition: ModelDefinition): PublishedModel {
  return {
    id: `mdl_${definition.key}`,
    key: definition.key,
    route: definition.route,
    version: 1,
    state: "published",
    schemaHash: `hash_${definition.key}`,
    compatibility: "initial",
    definition,
    publishedAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("Creation Draft baseline model semantics", () => {
  const descriptors = creationDraftModelDescriptors([
    published(TASK_MODEL_DEFINITION),
    published(WISH_MODEL_DEFINITION),
    published(DAY_RECORD_MODEL_DEFINITION),
    published(EVENT_MODEL_DEFINITION),
  ]);
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));

  it("gives every HomeMew baseline model an explicit semantic description", () => {
    for (const key of ["task", "wish", "day_record", "event"]) {
      const descriptor = byKey.get(key);
      expect(descriptor).toBeDefined();
      expect(descriptor?.description).toBeTruthy();
      expect(descriptor?.description).not.toBe(`${descriptor?.name} LifeSpace record`);
      expect(descriptor?.description.length).toBeGreaterThan(80);
    }
  });

  it("distinguishes concrete work, scheduled occurrences, date trackers, and aspirations", () => {
    expect(byKey.get("task")?.description).toContain("concrete to-dos");
    expect(byKey.get("task")?.description).toContain("deadline");

    expect(byKey.get("event")?.description).toContain("calendar occurrence");
    expect(byKey.get("event")?.description).toContain("specific date or time");

    expect(byKey.get("day_record")?.description).toContain("date-anchored tracker");
    expect(byKey.get("day_record")?.description).toContain("counting down");

    expect(byKey.get("wish")?.description).toContain("aspiration");
    expect(byKey.get("wish")?.description).toContain("Never use Wish as a fallback");
  });

  it("exposes discriminating field semantics to the AI provider", () => {
    const taskFields = new Map(byKey.get("task")?.fields.map((field) => [field.key, field]));
    expect(taskFields.get("dueDate")?.description).toContain("deadline");

    const eventFields = new Map(byKey.get("event")?.fields.map((field) => [field.key, field]));
    expect(eventFields.get("startAt")?.description).toContain("timed occurrence");

    const dayFields = new Map(byKey.get("day_record")?.fields.map((field) => [field.key, field]));
    expect(dayFields.get("anchorDate")?.description).toContain("anchors");

    const wishFields = new Map(byKey.get("wish")?.fields.map((field) => [field.key, field]));
    expect(wishFields.get("desiredDate")?.description).toContain("hoped-for date");
  });
});
