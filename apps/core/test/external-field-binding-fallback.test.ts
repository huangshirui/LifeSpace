import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import { validateExternalSnapshot } from "../src/external-model";

const snapshot = validateExternalSnapshot({
  resourceId: "synthetic",
  displayName: "Synthetic",
  fields: [{
    key: "provider_key",
    sourceFieldId: "provider_cn",
    title: "体重",
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

describe("External non-ASCII field keys", () => {
  it("uses deterministic field-hash fallback without translation", async () => {
    const first = (await resolveExternalFieldKeys(snapshot, [])).snapshot.fields[0]?.key;
    const second = (await resolveExternalFieldKeys(snapshot, [])).snapshot.fields[0]?.key;
    expect(first).toMatch(/^field[a-f0-9]{8}$/u);
    expect(second).toBe(first);
  });
});
