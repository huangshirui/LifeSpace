import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCapabilityAwareResource } from "../src/capability-runtime";
import type { Bindings, Principal } from "../src/env";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_capability_mutation_authority",
  clientId: "app_test_runtime",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_capability_mutation_authority",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Capability Mutation Authority", actor.id, now, now, "UTC").run();
  const model = await getPublishedModel(bindings(), "day_record");
  if (!model) throw new Error("bootstrap Day Record model is missing");
  return { spaceId, model, today: now.slice(0, 10) };
}

describe("Capability Mutation Authority", () => {
  it("keeps client read-only provenance separate from trusted Temporal preparation", async () => {
    const f = await fixture();

    await expect(createCapabilityAwareResource(bindings(), actor, f.spaceId, f.model, {
      name: "Client-forced status",
      kind: "elapsed",
      anchorDate: f.today,
      status: "active",
    })).rejects.toMatchObject({
      code: "INVALID_RESOURCE",
      message: "Field status is read-only",
      status: 400,
    });

    const created = await createCapabilityAwareResource(bindings(), actor, f.spaceId, f.model, {
      name: "Capability-owned status",
      kind: "elapsed",
      anchorDate: f.today,
    });
    expect(created.data).toMatchObject({ status: "active" });
  });
});
