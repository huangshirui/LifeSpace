import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { WISH_MODEL_DEFINITION } from "../src/builtin-models";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource, updateGenericResource } from "../src/generic-resource";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";
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
  const model = await getPublishedModel(bindings(), "wish")
    ?? await publishModelDefinition(bindings(), publisher, WISH_MODEL_DEFINITION, "initial");
  return {
    spaceId,
    owner: principal(ownerId),
    helper: principal(helperId),
    ownerPersonId,
    model,
  };
}

describe("Wish as Model Definition + Policy + Workflow", () => {
  it("publishes only the open/fulfilled lifecycle and fulfill/reopen Actions with Action-owned status", () => {
    expect(WISH_MODEL_DEFINITION.fields.status).toMatchObject({
      values: ["open", "fulfilled"],
      readOnly: true,
    });
    expect(Object.keys(WISH_MODEL_DEFINITION.fields).sort()).toEqual([
      "description",
      "desiredDate",
      "fulfilledAt",
      "ownerPersonId",
      "status",
      "title",
    ]);
    expect(Object.keys(WISH_MODEL_DEFINITION.actions ?? {}).sort()).toEqual(["fulfill", "reopen"]);
    expect(WISH_MODEL_DEFINITION.query?.filterable).toEqual(["status", "ownerPersonId", "desiredDate"]);
  });

  it("lets any authorized Person fulfill or reopen while keeping content ownership", async () => {
    const f = await fixture();
    const createInput = {
      title: "Weekend hike",
      description: "Go together",
      desiredDate: "2026-08-30",
      ownerPersonId: f.ownerPersonId,
    };
    await requireModelPolicy(bindings(), f.owner, f.spaceId, f.model, "create", undefined, createInput);
    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.model, "create", undefined, createInput))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const wish = await createGenericResource(bindings(), f.owner, f.spaceId, f.model, createInput);
    expect(wish.data.status).toBe("open");

    await expect(updateGenericResource(bindings(), f.owner, f.spaceId, f.model, wish.id, 1, { status: "fulfilled" }))
      .rejects.toMatchObject({ code: "INVALID_RESOURCE", status: 400 });

    const fulfilled = await executeWorkflowAction(bindings(), f.helper, f.spaceId, f.model, wish.id, "fulfill", 1);
    expect(fulfilled.data.status).toBe("fulfilled");
    expect(typeof fulfilled.data.fulfilledAt).toBe("string");
    expect(fulfilled.data).not.toHaveProperty("claimantPersonId");
    expect(fulfilled.data).not.toHaveProperty("fulfilledByPersonId");

    const reopened = await executeWorkflowAction(bindings(), f.helper, f.spaceId, f.model, wish.id, "reopen", 2);
    expect(reopened.data).toMatchObject({ status: "open", fulfilledAt: null });

    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.model, "update", reopened, { title: "Changed" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
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
