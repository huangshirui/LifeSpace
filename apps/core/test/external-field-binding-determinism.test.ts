import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import type { ExternalSnapshot } from "../src/external-model";

const baseField = {
  key: "provider_key",
  title: "Name",
  type: "string" as const,
  nullable: true,
  readable: true,
  writable: true,
  operators: [],
  sortable: false,
};
function snapshot(ids: string[]): ExternalSnapshot {
  return {
    resourceId: "synthetic",
    displayName: "Synthetic",
    fields: ids.map((sourceFieldId) => ({ ...baseField, sourceFieldId })),
    capabilities: {
      get: true, query: true, create: true, update: true, delete: true,
      batchWrite: false, atomicBatch: false, transaction: false,
      versionedWrite: false, actions: false, relationTargetResolution: false,
    },
    queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
    adapterState: {},
  };
}

describe("External key determinism", () => {
  it("is independent from Provider discovery order", async () => {
    const first = await resolveExternalFieldKeys(snapshot(["provider_b", "provider_a"]), []);
    const second = await resolveExternalFieldKeys(snapshot(["provider_a", "provider_b"]), []);
    const map = (value: typeof first) => Object.fromEntries(value.snapshot.fields.map((field) => [field.sourceFieldId, field.key]));
    expect(map(first)).toEqual(map(second));
  });
});
