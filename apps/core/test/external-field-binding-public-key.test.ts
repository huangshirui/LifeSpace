import { describe, expect, it } from "vitest";
import { FIELD_KEY, RESERVED_FIELDS } from "../src/model-definition";
import { resolveExternalFieldKeys } from "../src/external-field-binding";
import type { ExternalSnapshot } from "../src/external-model";

const snapshot: ExternalSnapshot = {
  resourceId: "synthetic",
  displayName: "Synthetic",
  fields: [{
    key: "provider_key",
    sourceFieldId: "provider_title",
    title: "Display Name",
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
};

describe("External public field key", () => {
  it("uses the Native key language and avoids reserved envelope fields", async () => {
    const key = (await resolveExternalFieldKeys(snapshot, [])).snapshot.fields[0]?.key ?? "";
    expect(FIELD_KEY.test(key)).toBe(true);
    expect(RESERVED_FIELDS.has(key)).toBe(false);
    expect(key).toBe("displayName");
  });
});
