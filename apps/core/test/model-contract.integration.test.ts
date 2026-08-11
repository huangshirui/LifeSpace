import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { getOrCreateActiveModelContract, readModelContract } from "../src/model-contract-service";
import { publishModelDefinition, retireModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const publisher: Principal = {
  type: "service",
  id: "svc_model_contract_test",
  clientId: "lifespace-platform-admin",
  scopes: ["models:manage"],
  tokenId: "tok_model_contract_test",
};

function noteDefinition() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return {
    definitionVersion: 1,
    key: `contract_note_${suffix}`,
    route: `contract-notes-${suffix}`,
    display: { singular: "Contract Note", plural: "Contract Notes" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
      body: { type: "text", nullable: true, maxLength: 5000 },
    },
    query: { searchable: ["title", "body"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

describe("Model Contract Revision Store", () => {
  it("bootstraps, advances atomically on publish/retire, and preserves history", async () => {
    const initial = await getOrCreateActiveModelContract(bindings());
    expect(initial.id).toMatch(/^mct_[a-f0-9]{64}$/u);
    expect(initial.registryRevision).toBeGreaterThanOrEqual(0);
    expect(initial.manifest.models.some((model) => model.key === "task")).toBe(true);

    const definition = noteDefinition();
    await publishModelDefinition(bindings(), publisher, definition, "initial");
    const afterPublish = await getOrCreateActiveModelContract(bindings());
    expect(afterPublish.id).not.toBe(initial.id);
    expect(afterPublish.registryRevision).toBe(initial.registryRevision + 1);
    expect(afterPublish.manifest.models.some((model) => model.key === definition.key)).toBe(true);

    const historical = await readModelContract(bindings(), initial.id);
    expect(historical.hash).toBe(initial.hash);
    expect(historical.manifest).toEqual(initial.manifest);

    await retireModel(bindings(), publisher, definition.key);
    const afterRetire = await getOrCreateActiveModelContract(bindings());
    expect(afterRetire.id).not.toBe(afterPublish.id);
    expect(afterRetire.registryRevision).toBe(afterPublish.registryRevision + 1);
    expect(afterRetire.manifest.models.some((model) => model.key === definition.key)).toBe(false);

    const publishedRevision = await readModelContract(bindings(), afterPublish.id);
    expect(publishedRevision.manifest.models.some((model) => model.key === definition.key)).toBe(true);
  });

  it("stores content-addressed revisions only once", async () => {
    const active = await getOrCreateActiveModelContract(bindings());
    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT COUNT(*) count FROM model_contract_revisions WHERE id=? AND contract_hash=?")
      .bind(active.id, active.hash).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});
