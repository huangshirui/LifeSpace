import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import { validateExternalSnapshot } from "../src/external-model";

const snapshot = validateExternalSnapshot({
  resourceId: "synthetic",
  displayName: "Synthetic",
  fields: [{
    key: "provider_key",
    sourceFieldId: "provider_weight",
    title: "Current Weight",
    type: "number",
    nullable: true,
    readable: true,
    writable: true,
    operators: [],
    sortable: false,
  }],
  capabilities: {
    get: true, query: true, create: true, update: true, delete: true,
    batchWrite: false, atomicBatch: false, transaction: false,
    versionedWrite: false, actions: false, relationTargetResolution: false,
  },
  queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
  adapterState: {},
});

describe("External field rename", () => {
  it("uses persisted source identity rather than regenerated title key", async () => {
    const result = await resolveExternalFieldKeys(snapshot, [{
      model_key: "ext_test",
      source_field_id: "provider_weight",
      field_key: "weight",
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:00:00Z",
    }]);
    expect(result.snapshot.fields[0]?.key).toBe("weight");
    expect(result.snapshot.fields[0]?.title).toBe("Current Weight");
  });
});
