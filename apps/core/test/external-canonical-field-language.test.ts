import { describe, expect, it } from "vitest";
import { CANONICAL_FIELD_TYPES } from "../src/model-definition";
import { resolveExternalFieldKeys, type ExternalFieldBinding } from "../src/external-field-binding";
import { validateExternalSnapshot, type ExternalSnapshot } from "../src/external-model";
import { externalRecordDto } from "../src/external-runtime";

const baseSnapshot = (type: string) => ({
  resourceId: "synthetic_resource",
  displayName: "Synthetic canonical fields",
  fields: [{
    key: "value",
    sourceFieldId: "provider_field_1",
    title: "Value",
    type,
    nullable: false,
    readable: true,
    writable: true,
    operators: [],
    sortable: false,
    ...(type === "enum" || type === "enum_list" ? { values: ["a", "b"] } : {}),
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

const binding = (sourceFieldId: string, key: string): ExternalFieldBinding => ({
  model_key: "ext_test",
  source_field_id: sourceFieldId,
  field_key: key,
  created_at: "2026-10-17T00:00:00.000Z",
  updated_at: "2026-10-17T00:00:00.000Z",
});

describe("External Canonical Field Language", () => {
  it("accepts every current CanonicalFieldType without an External-specific whitelist", () => {
    for (const type of CANONICAL_FIELD_TYPES) {
      expect(validateExternalSnapshot(baseSnapshot(type)).fields[0]?.type).toBe(type);
    }
  });

  it("accepts provider-provisional keys only before Core stable-key assignment", () => {
    const snapshot = baseSnapshot("string");
    snapshot.fields[0]!.key = `f_${"a".repeat(32)}`;
    expect(validateExternalSnapshot(snapshot, "provider").fields[0]?.key).toBe(snapshot.fields[0]!.key);
    expect(() => validateExternalSnapshot(snapshot)).toThrow();
  });

  it("generates readable keys, stable fallbacks and reserved-word suffixes deterministically", async () => {
    const readable = validateExternalSnapshot(baseSnapshot("string"));
    readable.fields[0]!.title = "Start Date";
    expect((await resolveExternalFieldKeys(readable, [])).snapshot.fields[0]?.key).toBe("startDate");

    const nonAscii = validateExternalSnapshot(baseSnapshot("string"));
    nonAscii.fields[0]!.title = "体重";
    expect((await resolveExternalFieldKeys(nonAscii, [])).snapshot.fields[0]?.key).toMatch(/^field[a-f0-9]{8}$/u);

    const reserved = validateExternalSnapshot(baseSnapshot("string"));
    reserved.fields[0]!.title = "ID";
    expect((await resolveExternalFieldKeys(reserved, [])).snapshot.fields[0]?.key).toMatch(/^id[a-f0-9]{6}$/u);
  });

  it("keeps persisted identity across rename and does not reuse a retired same-name key", async () => {
    const renamed = validateExternalSnapshot(baseSnapshot("string"));
    renamed.fields[0]!.title = "Current Weight";
    expect((await resolveExternalFieldKeys(renamed, [binding("provider_field_1", "weight")])).snapshot.fields[0]?.key).toBe("weight");

    const recreated = validateExternalSnapshot(baseSnapshot("string"));
    recreated.fields[0]!.sourceFieldId = "provider_field_2";
    recreated.fields[0]!.title = "Name";
    expect((await resolveExternalFieldKeys(recreated, [binding("retired_provider_field", "name")])).snapshot.fields[0]?.key).toMatch(/^name[a-f0-9]{6}$/u);
  });

  it("resolves same-name collisions independently of discovery order", async () => {
    const first = validateExternalSnapshot(baseSnapshot("string"));
    const left = { ...first.fields[0]!, sourceFieldId: "provider_a", title: "Name", key: "left" };
    const right = { ...first.fields[0]!, sourceFieldId: "provider_b", title: "Name", key: "right" };
    const a = { ...first, fields: [left, right] } as ExternalSnapshot;
    const b = { ...first, fields: [right, left] } as ExternalSnapshot;
    const keysA = (await resolveExternalFieldKeys(a, [])).snapshot.fields.map((field) => [field.sourceFieldId, field.key]);
    const keysB = (await resolveExternalFieldKeys(b, [])).snapshot.fields.map((field) => [field.sourceFieldId, field.key]);
    expect(keysA).toEqual(keysB);
    expect(keysA.every(([, key]) => /^name[a-f0-9]{6}$/u.test(key))).toBe(true);
  });

  it("uses the canonical structured value validator at the External record boundary", async () => {
    const snapshot = validateExternalSnapshot(baseSnapshot("range<date>"));
    const field = snapshot.fields[0]!;
    const dto = await externalRecordDto(
      {
        space_id: "spc_test",
        model_key: "ext_test",
        schema_hash: "schema",
        snapshot,
      } as never,
      {
        id: "rec_external_test",
        data: {
          [field.key]: { start: "2026-10-01", endExclusive: "2026-10-02" },
        },
      },
    );
    expect(dto[field.key]).toEqual({
      start: "2026-10-01",
      endExclusive: "2026-10-02",
    });
  });

  it("uses the same entity_ref value semantics for External records", async () => {
    const snapshot = validateExternalSnapshot(baseSnapshot("entity_ref"));
    const field = snapshot.fields[0]!;
    const dto = await externalRecordDto(
      {
        space_id: "spc_test",
        model_key: "ext_test",
        schema_hash: "schema",
        snapshot,
      } as never,
      {
        id: "rec_external_test",
        data: { [field.key]: { kind: "record", modelKey: "task", recordId: "rec_test" } },
      },
    );
    expect(dto[field.key]).toEqual({ kind: "record", modelKey: "task", recordId: "rec_test" });
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
