import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import type { Bindings, Principal } from "../src/env";
import { getActiveModelContract } from "../src/model-contract-store";
import { getPublishedModel, getPublishedModelByRoute, publishModelDefinition, retireModel, validateDefinition } from "../src/model-registry";
import { physicalTableName } from "../src/physical-schema";

type TestEnv = { DB: D1Database };

type TableInfoRow = {
  name: string;
  type: string;
};

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const publisher: Principal = {
  type: "service",
  id: "svc_model_registry_test",
  clientId: "lifespace-admin-test",
  scopes: ["models:manage"],
  tokenId: "tok_model_registry_test",
};

function noteDefinition(route = "notes") {
  return {
    definitionVersion: 1,
    key: `note_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
    route,
    display: { singular: "Note", plural: "Notes" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
      body: { type: "text", nullable: true, maxLength: 5000 },
    },
    query: { searchable: ["title", "body"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

describe("Model Registry", () => {
  it("loads the canonical shipped Task definition from D1", async () => {
    const expected = await validateDefinition(TASK_MODEL_DEFINITION);
    expect(expected.valid).toBe(true);
    if (!expected.valid) return;

    const model = await getPublishedModel(bindings(), "task");
    expect(model).not.toBeNull();
    expect(model?.route).toBe(TASK_MODEL_DEFINITION.route);
    expect(model?.schemaHash).toBe(expected.schemaHash);
    expect(model?.definition).toEqual(expected.definition);
  });

  it("publishes a validated model, creates its typed table and resolves it by route", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const published = await publishModelDefinition(bindings(), publisher, definition, "initial");
    expect(published.version).toBe(1);
    expect(published.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    const byRoute = await getPublishedModelByRoute(bindings(), definition.route);
    expect(byRoute?.key).toBe(definition.key);

    const table = physicalTableName(definition.key);
    const columns = await (env as unknown as TestEnv).DB.prepare(`PRAGMA table_info("${table}")`).all<TableInfoRow>();
    expect(columns.results.map((column) => [column.name, column.type])).toEqual([
      ["record_id", "TEXT"],
      ["space_id", "TEXT"],
      ["title", "TEXT"],
      ["body", "TEXT"],
    ]);
  });

  it("rejects Kernel Space routes before Registry or Model Contract mutation", async () => {
    const definition = noteDefinition("members");
    const before = await getActiveModelContract(bindings());

    await expect(publishModelDefinition(bindings(), publisher, definition, "initial"))
      .rejects.toMatchObject({ code: "INVALID_MODEL_DEFINITION" });

    expect(await getPublishedModel(bindings(), definition.key)).toBeNull();
    const after = await getActiveModelContract(bindings());
    expect(after?.id).toBe(before?.id);
    const paths = (after?.openapi as { paths?: Record<string, unknown> } | undefined)?.paths ?? {};
    expect(paths["/api/v1/spaces/{spaceId}/members"]).toBeUndefined();
  });

  it("supersedes an immutable published version and applies compatible additive DDL", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const first = await publishModelDefinition(bindings(), publisher, definition, "initial");
    const second = await publishModelDefinition(bindings(), publisher, {
      ...definition,
      fields: {
        ...definition.fields,
        pinned: { type: "boolean" },
      },
    }, "compatible");

    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);

    const old = await (env as unknown as TestEnv).DB.prepare("SELECT state,superseded_at FROM model_definitions WHERE id=?")
      .bind(first.id).first<{ state: string; superseded_at: string | null }>();
    expect(old?.state).toBe("superseded");
    expect(old?.superseded_at).toBeTruthy();

    const table = physicalTableName(definition.key);
    const columns = await (env as unknown as TestEnv).DB.prepare(`PRAGMA table_info("${table}")`).all<TableInfoRow>();
    expect(columns.results.some((column) => column.name === "pinned" && column.type === "INTEGER")).toBe(true);
  });

  it("rejects physical rewrites before changing the active Registry version", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const first = await publishModelDefinition(bindings(), publisher, definition, "initial");

    await expect(publishModelDefinition(bindings(), publisher, {
      ...definition,
      fields: {
        ...definition.fields,
        title: { ...definition.fields.title, type: "text" },
      },
    }, "breaking")).rejects.toMatchObject({ code: "MODEL_PHYSICAL_MIGRATION_REQUIRED" });

    const stillPublished = await getPublishedModel(bindings(), definition.key);
    expect(stillPublished?.id).toBe(first.id);
    expect(stillPublished?.version).toBe(1);
  });

  it("retires the active model without deleting version history", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const published = await publishModelDefinition(bindings(), publisher, definition, "initial");
    await retireModel(bindings(), publisher, definition.key);
    expect(await getPublishedModel(bindings(), definition.key)).toBeNull();

    const history = await (env as unknown as TestEnv).DB.prepare("SELECT state FROM model_definitions WHERE id=?")
      .bind(published.id).first<{ state: string }>();
    expect(history?.state).toBe("retired");
  });
});
