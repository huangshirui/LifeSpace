import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import { validateExternalSnapshot } from "../src/external-model";

const snapshot = validateExternalSnapshot({
  resourceId: "synthetic",
  displayName: "Synthetic",
  fields: [{
    key: "provider_key",
    sourceFieldId: "provider_id",
    title: "ID",
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

describe("External reserved field keys", () => {
  it("keeps the semantic base and appends a deterministic suffix", async () => {
    const field = (await resolveExternalFieldKeys(snapshot, [])).snapshot.fields[0];
    expect(field?.key).toMatch(/^id[a-f0-9]{6}$/u);
  });
});
