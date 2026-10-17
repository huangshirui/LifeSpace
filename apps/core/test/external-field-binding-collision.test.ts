import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import { validateExternalSnapshot } from "../src/external-model";

function snapshot(sourceFieldId: string) {
  return validateExternalSnapshot({
    resourceId: "synthetic",
    displayName: "Synthetic",
    fields: [{
      key: "provider_key",
      sourceFieldId,
      title: "Name",
      type: "string",
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
}

describe("External field-key collision", () => {
  it("does not reuse an historical key for a new source identity", async () => {
    const result = await resolveExternalFieldKeys(snapshot("provider_new"), [{
      model_key: "ext_test",
      source_field_id: "provider_old",
      field_key: "name",
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:00:00Z",
    }]);
    expect(result.snapshot.fields[0]?.key).toMatch(/^name[a-f0-9]{6}$/u);
  });
});
