import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import {
  canonicalizeStoredExternalSnapshot,
  type ExternalModelRow,
} from "../src/external-model";

function legacySnapshot() {
  const oldKey = `f_${"a".repeat(32)}`;
  return {
    resourceId: "synthetic_resource",
    displayName: "Synthetic records",
    fields: [{
      key: oldKey,
      sourceFieldId: "stable_property",
      title: "Amount",
      type: "number",
      nullable: true,
      readable: true,
      writable: true,
      operators: ["eq", "gt"],
      sortable: true,
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
    adapterState: {
      codecs: {
        [oldKey]: { id: "stable_property", type: "number" },
      },
    },
  };
}

type FakeStatement = {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => FakeStatement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
};

function fakeBindings() {
  const prepared: FakeStatement[] = [];
  let batches = 0;
  const db = {
    prepare(sql: string): FakeStatement {
      const statement: FakeStatement = {
        sql,
        args: [],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async all<T>() {
          if (sql.includes("FROM external_field_bindings")) return { results: [] as T[] };
          throw new Error(`Unexpected all(): ${sql}`);
        },
        async first<T>() {
          throw new Error(`Unexpected first(): ${sql}`);
        },
        async run() {
          throw new Error(`Unexpected run(): ${sql}`);
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: FakeStatement[]) {
      batches += 1;
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return {
    env: { DB: db } as unknown as Bindings,
    prepared,
    batchCount: () => batches,
  };
}

function legacyRow(snapshot = legacySnapshot()): ExternalModelRow {
  return {
    definition_key: "external_synthetic",
    model_key: "ext_legacy_test",
    space_id: "spc_test",
    source_id: "cnx_test",
    provider_key: "synthetic",
    resource_id: snapshot.resourceId,
    display_name: snapshot.displayName,
    declared_access: "write",
    snapshot_json: JSON.stringify(snapshot),
    schema_hash: "legacy-schema-hash",
    schema_observed_at: "2026-10-01T00:00:00.000Z",
    status: "active",
    last_successful_refresh_at: "2026-10-01T00:00:00.000Z",
    last_error_code: null,
    next_refresh_at: "2026-10-18T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

describe("legacy External field-key migration", () => {
  it("canonicalizes a provider-valid legacy snapshot locally without Provider I/O", async () => {
    const { env, prepared, batchCount } = fakeBindings();
    const row = legacyRow();

    const result = await canonicalizeStoredExternalSnapshot(env, row);

    expect(result.snapshot.fields[0]?.key).toBe("amount");
    expect(result.snapshot.fields[0]?.sourceFieldId).toBe("stable_property");
    expect(result.snapshot.adapterState).toEqual(legacySnapshot().adapterState);
    expect(result.row.schema_hash).not.toBe(row.schema_hash);
    expect(result.row.schema_observed_at).toBe(row.schema_observed_at);
    expect(result.row.last_successful_refresh_at).toBe(row.last_successful_refresh_at);
    expect(batchCount()).toBe(1);

    const bindingInsert = prepared.find((statement) =>
      statement.sql.startsWith("INSERT INTO external_field_bindings"),
    );
    expect(bindingInsert?.args.slice(0, 3)).toEqual([
      row.model_key,
      "stable_property",
      "amount",
    ]);

    const snapshotUpdate = prepared.find((statement) =>
      statement.sql.startsWith("UPDATE external_models SET snapshot_json="),
    );
    expect(snapshotUpdate?.sql).not.toContain("schema_observed_at");
    expect(snapshotUpdate?.args.at(-2)).toBe(row.model_key);
    expect(snapshotUpdate?.args.at(-1)).toBe(row.snapshot_json);
  });

  it("does not use key migration to hide a non-key contract violation", async () => {
    const { env } = fakeBindings();
    const snapshot = legacySnapshot();
    snapshot.fields[0]!.operators = ["not-a-canonical-operator"];

    await expect(canonicalizeStoredExternalSnapshot(env, legacyRow(snapshot))).rejects.toThrow();
  });
});
