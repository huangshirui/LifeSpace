import { describe, expect, it } from "vitest";
import { validateResourceData } from "../src/generic-resource";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";
import { dehydrateTypedResourceData, hydrateTypedResourceData } from "../src/typed-resource-storage";

const first = `fil_${"a".repeat(32)}`;
const second = `fil_${"b".repeat(32)}`;

function model(): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: "file_storage_probe",
    display: { singular: "File storage probe", plural: "File storage probes" },
    access: ["read", "write"],
    fields: {
      name: { type: "string", required: true },
      attachment: { type: "file", nullable: true },
      attachments: { type: "file_list", nullable: true },
      tags: { type: "enum_list", values: ["one", "two"] },
    },
  };
  return {
    id: "mdl_test",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-10-18T00:00:00.000Z",
  };
}

describe("Native file_list typed persistence", () => {
  it("round-trips File ID arrays through JSON TEXT without exposing encoded strings", () => {
    const published = model();
    const canonical = validateResourceData(published.definition, {
      name: "Report", attachment: first, attachments: [first, second], tags: ["one", "two"],
    }, "create");

    const stored = dehydrateTypedResourceData(published, canonical);
    expect(stored).toEqual({
      name: "Report", attachment: first,
      attachments: JSON.stringify([first, second]), tags: JSON.stringify(["one", "two"]),
    });
    const hydrated = hydrateTypedResourceData(published, stored, "rec_test");
    expect(hydrated).toEqual(canonical);
    expect(Array.isArray(hydrated.attachments)).toBe(true);
  });

  it("preserves empty arrays and nullable file fields", () => {
    const published = model();
    const stored = dehydrateTypedResourceData(published, {
      name: "Empty", attachment: null, attachments: [], tags: [],
    });
    expect(stored.attachments).toBe("[]");
    expect(hydrateTypedResourceData(published, stored, "rec_empty")).toEqual({
      name: "Empty", attachment: null, attachments: [], tags: [],
    });
    expect(hydrateTypedResourceData(published, {
      name: "Null", attachment: null, attachments: null, tags: null,
    }, "rec_null")).toEqual({
      name: "Null", attachment: null, attachments: null,
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ fileId: first }),
    JSON.stringify([first, first]),
    JSON.stringify(["fil_wrong"]),
    JSON.stringify([123]),
    JSON.stringify(Array.from({ length: 101 }, (_, n) => `fil_${n.toString(16).padStart(32, "0")}`)),
  ])("rejects malformed file_list storage rather than leaking a raw string (%s)", (corrupt) => {
    expect(() => hydrateTypedResourceData(model(), {
      name: "Corrupt", attachments: corrupt,
    }, "rec_corrupt")).toThrow("Stored structured field is invalid");
  });
});
