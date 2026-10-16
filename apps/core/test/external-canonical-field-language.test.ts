import { describe, expect, it } from "vitest";
import { CANONICAL_FIELD_TYPES } from "../src/model-definition";
import { validateExternalSnapshot } from "../src/external-model";

const baseSnapshot = (type: string) => ({
  resourceId: "synthetic_resource",
  displayName: "Synthetic canonical fields",
  fields: [{
    key: `f_${"a".repeat(32)}`,
    sourceFieldId: "provider_field_1",
    title: "Value",
    type,
    nullable: false,
    readable: true,
    writable: true,
    operators: [],
    sortable: false,
    ...(type === "enum" ? { values: ["a", "b"] } : {}),
    ...(type === "record" || type === "record_list" ? { targetModel: "task" } : {}),
  }],
  capabilities: {
    get: true,
    query: true,
    create: true,
    update: true,
    delete: true,
    batchWrite: true,
    atomicBatch: false,
    transaction: false,
    versionedWrite: false,
    actions: false,
    relationTargetResolution: false,
  },
  queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
  adapterState: {},
});

describe("External Canonical Field Language", () => {
  it("accepts every current CanonicalFieldType without an External-specific whitelist", () => {
    for (const type of CANONICAL_FIELD_TYPES) {
      expect(validateExternalSnapshot(baseSnapshot(type)).fields[0]?.type).toBe(type);
    }
  });

  it("rejects the legacy Native datetime alias because External speaks canonical types only", () => {
    expect(() => validateExternalSnapshot(baseSnapshot("datetime"))).toThrow();
  });

  it("uses the canonical enum bound rather than a separate External bound", () => {
    const snapshot = baseSnapshot("enum");
    snapshot.fields[0]!.values = Array.from({ length: 51 }, (_, index) => `v${index}`);
    expect(() => validateExternalSnapshot(snapshot)).toThrow();
  });
});
