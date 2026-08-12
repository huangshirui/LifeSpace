import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import {
  createAiModelProposal,
  discardAiModelProposal,
  getAiModelProposal,
  listAiModelProposals,
  publishAiModelProposal,
  type ModelAdminAiProvider,
} from "../src/model-admin-ai";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const admin: Principal = {
  type: "service",
  id: "svc_ai_model_admin_test",
  clientId: "lifespace-platform-admin",
  scopes: ["models:manage"],
  tokenId: "tok_ai_model_admin_test",
};

function suffix() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function basicDefinition(key: string, route: string) {
  return {
    definitionVersion: 1,
    key,
    route,
    description: "A simple AI-admin proving model.",
    display: { singular: "AI Note", plural: "AI Notes" },
    fields: {
      title: { type: "string", description: "Short title", required: true, minLength: 1, maxLength: 100 },
    },
    query: { searchable: ["title"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

function provider(definition: unknown, summary = "Generated proposal"): ModelAdminAiProvider {
  return {
    generate: async () => ({
      output: {
        definitionJson: JSON.stringify(definition),
        summary,
        warnings: [],
      },
      metadata: { providerStatus: 200 },
    }),
  } as ModelAdminAiProvider;
}

describe("AI Model Admin proposals", () => {
  it("creates and explicitly publishes a brand-new model proposal", async () => {
    const id = suffix();
    const key = `ai_note_${id}`;
    const definition = basicDefinition(key, `ai-notes-${id}`);

    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Create a simple note model" },
      provider(definition),
      new Date("2026-08-12T00:00:00.000Z"),
    );

    expect(proposal).toMatchObject({
      status: "proposed",
      modelKey: key,
      baseModelVersion: null,
      recommendedCompatibility: "initial",
    });
    expect(proposal.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.diff?.recommendedCompatibility).toBe("initial");
    expect(await getPublishedModel(bindings(), key)).toBeNull();

    const published = await publishAiModelProposal(
      bindings(),
      admin,
      proposal.id,
      "initial",
      new Date("2026-08-12T00:01:00.000Z"),
    );
    expect(published.publishedModel).toMatchObject({ key, version: 1, compatibility: "initial" });
    expect(published.proposal.status).toBe("published");
    expect((await getPublishedModel(bindings(), key))?.version).toBe(1);
  });

  it("recommends compatible for an additive optional-field update and publishes it", async () => {
    const id = suffix();
    const key = `ai_add_${id}`;
    const route = `ai-add-${id}`;
    const first = await publishModelDefinition(bindings(), admin, basicDefinition(key, route), "initial");

    const next = {
      ...first.definition,
      fields: {
        ...first.definition.fields,
        notes: { type: "text", description: "Optional notes", nullable: true, maxLength: 5000 },
      },
      query: {
        ...first.definition.query,
        searchable: [...(first.definition.query?.searchable ?? []), "notes"],
      },
    };

    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Add optional notes and make them searchable", targetModelKey: key },
      provider(next),
    );

    expect(proposal).toMatchObject({
      status: "proposed",
      modelKey: key,
      baseModelVersion: 1,
      recommendedCompatibility: "compatible",
    });
    expect(proposal.diff?.breakingReasons).toEqual([]);

    const result = await publishAiModelProposal(bindings(), admin, proposal.id, "compatible");
    expect(result.publishedModel).toMatchObject({ key, version: 2, compatibility: "compatible" });
    expect((await getPublishedModel(bindings(), key))?.definition.fields.notes).toBeTruthy();
  });

  it("does not allow a breaking proposal to be understated as compatible", async () => {
    const id = suffix();
    const key = `ai_break_${id}`;
    const route = `ai-break-${id}`;
    const first = await publishModelDefinition(bindings(), admin, basicDefinition(key, route), "initial");
    const next = {
      ...first.definition,
      fields: {
        ...first.definition.fields,
        title: { ...first.definition.fields.title, maxLength: 20 },
      },
    };

    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Limit title to 20 characters", targetModelKey: key },
      provider(next),
    );

    expect(proposal.recommendedCompatibility).toBe("breaking");
    expect(proposal.diff?.breakingReasons.join(" ")).toContain("title");

    await expect(publishAiModelProposal(bindings(), admin, proposal.id, "compatible"))
      .rejects.toMatchObject({ code: "MODEL_PROPOSAL_COMPATIBILITY_UNDERSTATED", status: 409 });

    const published = await publishAiModelProposal(bindings(), admin, proposal.id, "breaking");
    expect(published.publishedModel).toMatchObject({ key, version: 2, compatibility: "breaking" });
  });

  it("rejects a stale proposal after the target model changed independently", async () => {
    const id = suffix();
    const key = `ai_stale_${id}`;
    const route = `ai-stale-${id}`;
    const first = await publishModelDefinition(bindings(), admin, basicDefinition(key, route), "initial");
    const proposed = {
      ...first.definition,
      fields: {
        ...first.definition.fields,
        note: { type: "text", nullable: true, maxLength: 1000 },
      },
    };
    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Add note", targetModelKey: key },
      provider(proposed),
    );

    await publishModelDefinition(bindings(), admin, {
      ...first.definition,
      fields: {
        ...first.definition.fields,
        category: { type: "string", nullable: true, maxLength: 50 },
      },
    }, "compatible");

    await expect(publishAiModelProposal(bindings(), admin, proposal.id, "compatible"))
      .rejects.toMatchObject({ code: "MODEL_PROPOSAL_STALE", status: 409 });
  });

  it("stores invalid AI output as a non-publishable draft instead of executing escape hatches", async () => {
    const id = suffix();
    const key = `ai_invalid_${id}`;
    const invalid = {
      ...basicDefinition(key, `ai-invalid-${id}`),
      sql: "DROP TABLE spaces",
    };

    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Create a model and run this SQL" },
      provider(invalid, "Unsafe proposal should be rejected"),
    );

    expect(proposal.status).toBe("draft");
    expect(proposal.schemaHash).toBeNull();
    expect(proposal.recommendedCompatibility).toBeNull();
    const validation = proposal.validation as { valid: boolean; issues: Array<{ code: string }> };
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain("UNKNOWN_PROPERTY");
    expect(await getPublishedModel(bindings(), key)).toBeNull();

    await expect(publishAiModelProposal(bindings(), admin, proposal.id, "initial"))
      .rejects.toMatchObject({ code: "MODEL_PROPOSAL_STATE_CONFLICT", status: 409 });

    const discarded = await discardAiModelProposal(bindings(), proposal.id);
    expect(discarded.status).toBe("discarded");
    expect((await getAiModelProposal(bindings(), proposal.id)).status).toBe("discarded");
    expect((await listAiModelProposals(bindings(), "discarded")).some((item) => item.id === proposal.id)).toBe(true);
  });
});
