import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { WISH_MODEL_DEFINITION } from "../src/builtin-models";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { publishModelDefinition } from "../src/model-registry";
import { requireModelPolicy } from "../src/policy";
import { executeWorkflowAction } from "../src/workflow";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

function principal(id: string): Principal {
  return {
    type: "user",
    id,
    clientId: "homemew-miniprogram",
    scopes: ["resources:read", "resources:write"],
    tokenId: `tok_${id}`,
  };
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const ownerId = `usr_owner_${suffix}`;
  const helperId = `usr_helper_${suffix}`;
  const ownerPersonId = `per_owner_${suffix}`;
  const helperPersonId = `per_helper_${suffix}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Wish Metadata Test", ownerId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(ownerPersonId, spaceId, ownerId, "Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(helperPersonId, spaceId, helperId, "Helper", now, now),
  ]);
  const publisher: Principal = {
    type: "service",
    id: `svc_wish_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_wish_publisher_${suffix}`,
  };
  const model = await publishModelDefinition(bindings(), publisher, WISH_MODEL_DEFINITION, "initial");
  return {
    db,
    spaceId,
    owner: principal(ownerId),
    helper: principal(helperId),
    ownerPersonId,
    helperPersonId,
    model,
  };
}

describe("Wish as Model Definition + Policy + Workflow", () => {
  it("enforces ownership and claimant/fulfiller actions without a Wish runtime service", async () => {
    const f = await fixture();
    const createInput = {
      title: "Weekend hike",
      description: "Go together",
      desiredDate: "2026-08-30",
      status: "open",
      ownerPersonId: f.ownerPersonId,
    };
    await requireModelPolicy(bindings(), f.owner, f.spaceId, f.model, "create", undefined, createInput);
    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.model, "create", undefined, createInput))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const wish = await createGenericResource(bindings(), f.owner, f.spaceId, f.model, createInput);

    await expect(executeWorkflowAction(bindings(), f.owner, f.spaceId, f.model, wish.id, "claim", 1))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const claimed = await executeWorkflowAction(bindings(), f.helper, f.spaceId, f.model, wish.id, "claim", 1);
    expect(claimed.data).toMatchObject({ status: "claimed", claimantPersonId: f.helperPersonId });
    expect(typeof claimed.data.claimedAt).toBe("string");

    const fulfilled = await executeWorkflowAction(bindings(), f.helper, f.spaceId, f.model, wish.id, "fulfill", 2);
    expect(fulfilled.data).toMatchObject({ status: "fulfilled", fulfilledByPersonId: f.helperPersonId });

    await expect(executeWorkflowAction(bindings(), f.helper, f.spaceId, f.model, wish.id, "reopen", 3))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const reopened = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.model, wish.id, "reopen", 3);
    expect(reopened.data).toMatchObject({
      status: "open",
      claimantPersonId: null,
      claimedAt: null,
      fulfilledByPersonId: null,
      fulfilledAt: null,
    });
  });

  it("archives and restores the prior state with a bounded record-field workflow reference", async () => {
    const f = await fixture();
    const wish = await createGenericResource(bindings(), f.owner, f.spaceId, f.model, {
      title: "Archive proof",
      status: "open",
      ownerPersonId: f.ownerPersonId,
    });

    const archived = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.model, wish.id, "archive", 1);
    expect(archived.data).toMatchObject({ status: "archived", archivedFromStatus: "open" });

    const restored = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.model, wish.id, "restore", 2);
    expect(restored.data).toMatchObject({ status: "open", archivedFromStatus: null });
  });

  it("denies non-Person principals at the Wish policy boundary", async () => {
    const f = await fixture();
    const service: Principal = {
      type: "service",
      id: "svc_wish_attempt",
      clientId: "integration",
      scopes: ["resources:read", "resources:write"],
      tokenId: "tok_wish_attempt",
    };
    await expect(requireModelPolicy(bindings(), service, f.spaceId, f.model, "read"))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
  });
});
