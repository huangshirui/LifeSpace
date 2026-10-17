import { describe, expect, it } from "vitest";
import { resolveExternalFieldKeys, type ExternalFieldBinding } from "../src/external-field-binding";
import type { ExternalSnapshot } from "../src/external-model";

const snapshot = (title: string): ExternalSnapshot => ({
  resourceId: "synthetic_resource",
  displayName: "Synthetic",
  fields: [{
    key: "provider_provisional",
    sourceFieldId: "provider_field",
    title,
    type: "string",
    nullable: true,
    readable: true,
    writable: true,
    operators: [],
    sortable: false,
  }],
  capabilities: {
    get: true,
    query: true,
    create: true,
    update: true,
    delete: true,
    batchWrite: false,
    atomicBatch: false,
    transaction: false,
    versionedWrite: false,
    actions: false,
    relationTargetResolution: false,
  },
  queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
  adapterState: {},
});

const persisted = (fieldKey: string): ExternalFieldBinding => ({
  model_key: "ext_test",
  source_field_id: "provider_field",
  field_key: fieldKey,
  created_at: "2026-10-17T00:00:00.000Z",
  updated_at: "2026-10-17T00:00:00.000Z",
});

describe("External field binding authority", () => {
  it("uses the persisted binding even when a concurrent discovery would derive another title-based key", async () => {
    const staleDiscovery = await resolveExternalFieldKeys(snapshot("Old Name"), []);
    expect(staleDiscovery.snapshot.fields[0]?.key).toBe("oldName");

    const authoritative = await resolveExternalFieldKeys(snapshot("Old Name"), [persisted("newName")]);
    expect(authoritative.newBindings).toEqual([]);
    expect(authoritative.snapshot.fields[0]?.key).toBe("newName");
  });
});
