import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import {
  createAiModelProposal,
  getAiModelProposal,
  type ModelAdminAiProvider,
} from "../src/model-admin-ai";
import { acquireProposalPublicationClaim } from "../src/model-proposal-publication";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const admin: Principal = {
  type: "service",
  id: "svc_ai_atomic_test",
  clientId: "lifespace-platform-admin",
  scopes: ["models:manage"],
  tokenId: "tok_ai_atomic_test",
};

function provider(definition: unknown): ModelAdminAiProvider {
  return {
    generate: async () => ({
      output: {
        definitionJson: JSON.stringify(definition),
        summary: "Atomic publication proof",
        warnings: [],
      },
      metadata: { providerStatus: 200 },
    }),
  };
}

describe("AI model proposal atomic audit", () => {
  it("finalizes a claimed proposal in the same transaction as the matching Registry insert", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const key = `atomic_${suffix}`;
    const definition = {
      definitionVersion: 1,
      key,
      route: `atomic-${suffix}`,
      description: "Model used to prove atomic AI proposal audit finalization.",
      display: { singular: "Atomic Note", plural: "Atomic Notes" },
      fields: {
        title: { type: "string", required: true, minLength: 1, maxLength: 100 },
      },
      access: ["read", "write"],
      lifecycle: { optimisticConcurrency: true, softDelete: true },
    };

    const proposal = await createAiModelProposal(
      bindings(),
      admin,
      { instruction: "Create an atomic note model" },
      provider(definition),
      new Date("2026-08-12T00:00:00.000Z"),
    );
    expect(proposal.status).toBe("proposed");
    expect(proposal.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    await acquireProposalPublicationClaim(bindings(), {
      proposalId: proposal.id,
      modelKey: key,
      expectedVersion: 1,
      schemaHash: proposal.schemaHash!,
    }, new Date("2026-08-12T00:01:00.000Z"));

    const published = await publishModelDefinition(
      bindings(),
      admin,
      proposal.definition,
      "initial",
    );

    const audited = await getAiModelProposal(bindings(), proposal.id);
    expect(audited).toMatchObject({
      status: "published",
      publishedModelId: published.id,
      publicationInProgress: false,
    });
  });
});
