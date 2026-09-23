import { describe, expect, it } from "vitest";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
} from "../src/builtin-models";
import { generateModelContract } from "../src/model-contract";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { validateDefinition, type PublishedModel } from "../src/model-registry";
import { creationDraftModelDescriptors } from "../src/registry-creation-draft";

const baselineDefinitions = [
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
];
const releaseFingerprint = Object.freeze({
  task: Object.freeze({ version: 8, schemaHash: "fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6" }),
  wish: Object.freeze({ version: 7, schemaHash: "7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df" }),
  day_record: Object.freeze({ version: 5, schemaHash: "9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1" }),
  event: Object.freeze({ version: 6, schemaHash: "be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a" }),
});

function published(definition: ModelDefinition): PublishedModel {
  return {
    id: `mdl_${definition.key}`,
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: `hash_${definition.key}`,
    compatibility: "initial",
    definition,
    publishedAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("Creation Draft baseline model semantics", () => {
  const descriptors = creationDraftModelDescriptors(baselineDefinitions.map(published));
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));

  it("keeps all four semantic baseline definitions valid", () => {
    for (const definition of baselineDefinitions) {
      const result = validateModelDefinition(definition);
      expect(result.valid, definition.key).toBe(true);
    }
  });

  it("gives every baseline proving model an explicit semantic description", () => {
    for (const key of ["task", "wish", "day_record", "event"]) {
      const descriptor = byKey.get(key);
      expect(descriptor).toBeDefined();
      expect(descriptor?.description).toBeTruthy();
      expect(descriptor?.description).not.toBe(`${descriptor?.name} LifeSpace record`);
      expect(descriptor?.description.length).toBeGreaterThan(80);
    }
  });

  it("gives every built-in field an explicit semantic description", () => {
    for (const definition of baselineDefinitions) {
      for (const [fieldKey, field] of Object.entries(definition.fields)) {
        expect(field.description, `${definition.key}.${fieldKey}`).toBeTruthy();
      }
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
    expect(eventFields.get("when")?.description).toContain("date variant");
    expect(eventFields.get("when")?.description).toContain("instant variant");

    const dayFields = new Map(byKey.get("day_record")?.fields.map((field) => [field.key, field]));
    expect(dayFields.get("anchorDate")?.description).toContain("anchors");

    const wishFields = new Map(byKey.get("wish")?.fields.map((field) => [field.key, field]));
    expect(wishFields.get("desiredDate")?.description).toContain("hoped-for date");
  });

  it("pins the route-free release hashes and deterministic four-model contract", async () => {
    const models: PublishedModel[] = [];
    for (const definition of baselineDefinitions) {
      const expected = releaseFingerprint[definition.key as keyof typeof releaseFingerprint];
      const validated = await validateDefinition(definition);
      expect(validated.valid, definition.key).toBe(true);
      if (!validated.valid) continue;
      expect(validated.schemaHash, definition.key).toBe(expected.schemaHash);
      models.push({
        id: `mdl_${definition.key}_semantic`,
        key: definition.key,
        version: expected.version,
        state: "published",
        schemaHash: validated.schemaHash,
        compatibility: definition.key === "task" || definition.key === "day_record" ? "compatible" : "breaking",
        definition: validated.definition,
        publishedAt: "2026-09-08T00:00:00.000Z",
      });
    }

    const first = await generateModelContract(models);
    const second = await generateModelContract(models);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^mct_[a-f0-9]{64}$/u);
    expect(Object.fromEntries(first.manifest.models.map((model) => [model.key, {
      version: model.version,
      schemaHash: model.schemaHash,
    }]))).toEqual(releaseFingerprint);
  });
});
