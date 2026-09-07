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
  task: Object.freeze({ version: 6, schemaHash: "1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837" }),
  wish: Object.freeze({ version: 6, schemaHash: "4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3" }),
  day_record: Object.freeze({ version: 3, schemaHash: "7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa" }),
  event: Object.freeze({ version: 4, schemaHash: "66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4" }),
});
// This is the deterministic contract for an isolated Registry containing exactly
// the four baseline models above. A deployed Registry may legitimately have a
// different active mct_* when additional ordinary models are published.
const isolatedBaselineModelContract = "mct_322ae8926b5daade7db0dd667a1933d20d3e391838fd1e8c7aecc7e1f19cd4bd";

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
  const descriptors = creationDraftModelDescriptors(baselineDefinitions.map(published));
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));

  it("keeps all four semantic baseline definitions valid", () => {
    for (const definition of baselineDefinitions) {
      const result = validateModelDefinition(definition);
      expect(result.valid, definition.key).toBe(true);
    }
  });

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

  it("pins the exact release hashes and isolated four-model contract fingerprint", async () => {
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
        route: definition.route,
        version: expected.version,
        state: "published",
        schemaHash: validated.schemaHash,
        compatibility: "compatible",
        definition: validated.definition,
        publishedAt: "2026-08-21T00:00:00.000Z",
      });
    }
    const contract = await generateModelContract(models);
    expect(contract.id).toBe(isolatedBaselineModelContract);
  });
});
