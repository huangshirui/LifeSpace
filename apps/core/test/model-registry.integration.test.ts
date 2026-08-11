import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { getPublishedModel, getPublishedModelByRoute, publishModelDefinition, retireModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

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
  it("loads the bootstrap Task definition from D1", async () => {
    const model = await getPublishedModel(bindings(), "task");
    expect(model).not.toBeNull();
    expect(model?.route).toBe("tasks");
    expect(model?.version).toBe(1);
    expect(model?.schemaHash).toBe("1fd6d6fdc7bb6039503bf012aad9eeaf417459196b680133c4d2bf96ef9fb173");
  });

  it("publishes a validated model and resolves it by route", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const published = await publishModelDefinition(bindings(), publisher, definition, "initial");
    expect(published.version).toBe(1);
    expect(published.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    const byRoute = await getPublishedModelByRoute(bindings(), definition.route);
    expect(byRoute?.key).toBe(definition.key);
  });

  it("supersedes an immutable published version instead of overwriting it", async () => {
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
  });

  it("retires the active model without deleting version history", async () => {
    const definition = noteDefinition(`notes-${crypto.randomUUID().slice(0, 8)}`);
    const published = await publishModelDefinition(bindings(), publisher, definition, "initial");
    await retireModel(bindings(), definition.key);
    expect(await getPublishedModel(bindings(), definition.key)).toBeNull();

    const history = await (env as unknown as TestEnv).DB.prepare("SELECT state FROM model_definitions WHERE id=?")
      .bind(published.id).first<{ state: string }>();
    expect(history?.state).toBe("retired");
  });
});
