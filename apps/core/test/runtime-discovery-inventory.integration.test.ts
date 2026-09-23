import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Actor = { id: string };

type Fixture = {
  db: D1Database;
  privateKey: string;
  publicKey: string;
  userId: string;
  serviceId: string;
  agentId: string;
  clientId: string;
  firstSpaceId: string;
  secondSpaceId: string;
  modelKey: string;
  now: string;
};

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function token(
  privateKey: string,
  principalType: "user" | "service",
  principalId: string,
  clientId: string,
  scopes: string[],
  actor?: Actor,
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    ...(actor ? { actor_type: "agent", actor_id: actor.id, purpose: "delegated_agent" } : {}),
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function responseData(response: Response): Promise<any> {
  expect(response.status).toBe(200);
  return (await response.json<{ data: any }>()).data;
}

async function fixture(): Promise<Fixture> {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_inventory_${suffix}`;
  const serviceId = `svc_inventory_${suffix}`;
  const agentId = `agt_${suffix}`;
  const clientId = `app_inventory_${suffix}`;
  const firstSpaceId = `spc_inventory_a_${suffix}`;
  const secondSpaceId = `spc_inventory_b_${suffix}`;
  const modelKey = `inventory_note_${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(firstSpaceId, "Inventory A", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(secondSpaceId, "Inventory B", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_inventory_a_${suffix}`, firstSpaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_inventory_b_${suffix}`, secondSpaceId, userId, "editor", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_inventory_a_${suffix}`, firstSpaceId, userId, "Inventory Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_inventory_b_${suffix}`, secondSpaceId, userId, "Inventory Owner", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_inventory_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_inventory_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    display: { singular: "Inventory Note", plural: "Inventory Notes" },
    description: "Heavy semantic detail that must stay outside the compact inventory.",
    fields: {
      title: { type: "string", title: "Title", required: true, minLength: 1, maxLength: 120 },
      status: { type: "enum", title: "Status", required: true, values: ["open", "done"] },
    },
    defaults: { status: "open" },
    query: { searchable: ["title"], filterable: ["status"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    actions: {
      complete: {
        access: "write",
        guards: [{ field: "status", op: "neq", value: "done" }],
        set: { status: "done" },
      },
    },
  }, "initial");

  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

  return {
    db,
    privateKey,
    publicKey,
    userId,
    serviceId,
    agentId,
    clientId,
    firstSpaceId,
    secondSpaceId,
    modelKey,
    now,
  };
}

describe("Compact current Runtime capability inventory", () => {
  it("de-duplicates static model inventory while preserving current Space visibility edges and progressive detail identity", async () => {
    const f = await fixture();
    const bearer = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write"],
    );

    const inventory = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(inventory.semanticDetailPathTemplate).toBe("/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}");
    expect(inventory.models).toHaveLength(1);
    expect(inventory.models[0]).toMatchObject({
      key: f.modelKey,
      display: { singular: "Inventory Note", plural: "Inventory Notes" },
      capabilities: [],
      actions: [{ key: "complete", access: "write", kind: "workflow" }],
    });
    expect(inventory.models[0].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.models[0].version).toBeGreaterThanOrEqual(1);
    for (const heavy of ["description", "declaredAccess", "access", "fields", "defaults", "query", "capabilityBindings"]) {
      expect(inventory.models[0]).not.toHaveProperty(heavy);
    }

    expect(inventory.spaces.map((space: { spaceId: string }) => space.spaceId).sort()).toEqual([
      f.firstSpaceId,
      f.secondSpaceId,
    ].sort());
    for (const space of inventory.spaces) {
      expect(Object.keys(space).sort()).toEqual(["models", "spaceId", "spaceName"]);
      expect(space.models).toEqual([{ modelKey: f.modelKey, access: ["read", "write"] }]);
      expect(Object.keys(space.models[0]).sort()).toEqual(["access", "modelKey"]);
    }

    const detail = await responseData(await request(
      f.publicKey,
      bearer,
      `/api/v1/spaces/${f.firstSpaceId}/_discovery/models/${f.modelKey}`,
    ));
    expect({ key: detail.key, version: detail.version, schemaHash: detail.schemaHash }).toEqual({
      key: inventory.models[0].key,
      version: inventory.models[0].version,
      schemaHash: inventory.models[0].schemaHash,
    });
    expect(detail.fields.length).toBeGreaterThan(0);
    expect(detail.query).toBeTruthy();

    const legacy = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery"));
    expect(legacy.spaces).toHaveLength(2);
    expect(legacy.spaces[0].models[0].fields.length).toBeGreaterThan(0);
    expect(legacy.spaces[0].models[0].query).toBeTruthy();
  });

  it("tracks service model-Grant authority and removes the edge after Grant revoke", async () => {
    const f = await fixture();
    const grantId = `grt_inventory_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId, f.firstSpaceId, "service", f.serviceId, "model", f.modelKey, "read", f.userId, f.now, null,
    ).run();
    const bearer = await token(f.privateKey, "service", f.serviceId, f.clientId, ["resources:read"]);

    const before = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(before.models.map((model: { key: string }) => model.key)).toContain(f.modelKey);
    expect(before.spaces).toEqual([
      expect.objectContaining({
        spaceId: f.firstSpaceId,
        models: [{ modelKey: f.modelKey, access: ["read"] }],
      }),
    ]);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
    const after = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(after.models).toEqual([]);
    expect(after.spaces).toEqual([]);
  });

  it("intersects delegated-Agent visibility with the current Delegation and removes it after revoke", async () => {
    const f = await fixture();
    const delegationId = `dlg_inventory_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.batch([
      f.db.prepare(`INSERT INTO agent_delegations(
        id,principal_user_id,agent_id,application_id,source_space_id,created_by_user_id,created_at,expires_at,revoked_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
        delegationId, f.userId, f.agentId, f.clientId, f.firstSpaceId, f.userId, f.now, null, null,
      ),
      f.db.prepare(`INSERT INTO agent_delegation_models(delegation_id,model_key,max_access)
        VALUES(?,?,?)`).bind(delegationId, f.modelKey, "read"),
    ]);
    const bearer = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write"],
      { id: f.agentId },
    );

    const before = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(before.spaces).toEqual([
      expect.objectContaining({
        spaceId: f.firstSpaceId,
        models: [{ modelKey: f.modelKey, access: ["read"] }],
      }),
    ]);

    await f.db.prepare("UPDATE agent_delegations SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), delegationId).run();
    const after = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(after.models).toEqual([]);
    expect(after.spaces).toEqual([]);
  });

  it("removes current visibility after Application × Model Access is revoked", async () => {
    const f = await fixture();
    const bearer = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const before = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(before.models).toHaveLength(1);
    expect(before.spaces).toHaveLength(2);

    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?")
      .bind(f.clientId, f.modelKey).run();
    const after = await responseData(await request(f.publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(after.models).toEqual([]);
    expect(after.spaces).toEqual([]);
  });
});
