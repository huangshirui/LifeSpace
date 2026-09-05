import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

type AgentActor = { id: string };

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
  actor?: AgentActor,
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
    ...(actor ? { actor_type: "agent", actor_id: actor.id, purpose: "delegated_agent" } : {}),
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

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const serviceId = `svc_${suffix}`;
  const agentId = `agt_${suffix}`;
  const clientId = `app_me_discovery_${suffix}`;
  const memberSpaceId = `spc_member_${suffix}`;
  const sharedSpaceId = `spc_shared_${suffix}`;
  const modelKey = `me_discovery_note_${suffix.slice(0, 8)}`;
  const route = `me-discovery-notes-${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(memberSpaceId, "personal", "Member Space", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(sharedSpaceId, "family", "Shared Space", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, memberSpaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, memberSpaceId, userId, "Discovery Tester", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    route,
    display: { singular: "Discovery Note", plural: "Discovery Notes" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
    },
    query: { searchable: ["title"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
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
    memberSpaceId,
    sharedSpaceId,
    modelKey,
    now,
  };
}

describe("Current-principal Runtime Discovery", () => {
  it("discovers effective models across membership and grant-only Spaces with minimal labels but no Space administration detail", async () => {
    const f = await fixture();
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      `grt_${crypto.randomUUID().replaceAll("-", "")}`,
      f.sharedSpaceId,
      "user",
      f.userId,
      "model",
      f.modelKey,
      "write",
      f.userId,
      f.now,
      null,
    ).run();

    const accessToken = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write", "spaces:read"],
    );
    const response = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { spaces: Array<{ spaceId: string; spaceName: string; models: Array<{ key: string; access: string[] }>; name?: string; kind?: string; timezone?: string; role?: string }> } }>();

    expect(payload.data.spaces.map((space) => space.spaceId).sort()).toEqual([
      f.memberSpaceId,
      f.sharedSpaceId,
    ].sort());
    expect(Object.fromEntries(payload.data.spaces.map((space) => [space.spaceId, space.spaceName]))).toEqual({
      [f.memberSpaceId]: "Member Space",
      [f.sharedSpaceId]: "Shared Space",
    });
    for (const space of payload.data.spaces) {
      expect(space.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: f.modelKey, access: ["read", "write"] }),
      ]));
      expect(space).not.toHaveProperty("name");
      expect(space).not.toHaveProperty("kind");
      expect(space).not.toHaveProperty("timezone");
      expect(space).not.toHaveProperty("role");
    }

    const membershipSpaces = await request(f.publicKey, accessToken, "/api/v1/me/spaces");
    const membershipPayload = await membershipSpaces.json<{ data: Array<{ id: string }> }>();
    expect(membershipPayload.data.map((space) => space.id)).toContain(f.memberSpaceId);
    expect(membershipPayload.data.map((space) => space.id)).not.toContain(f.sharedSpaceId);
  });

  it("tracks service model grants across Spaces and drops revoked authority immediately", async () => {
    const f = await fixture();
    const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId,
      f.sharedSpaceId,
      "service",
      f.serviceId,
      "model",
      f.modelKey,
      "read",
      f.userId,
      f.now,
      null,
    ).run();

    const accessToken = await token(f.privateKey, "service", f.serviceId, f.clientId, ["resources:read", "resources:write"]);
    const first = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    const firstPayload = await first.json<{ data: { spaces: Array<{ spaceId: string; spaceName: string; models: Array<{ key: string; access: string[] }> }> } }>();
    expect(firstPayload.data.spaces).toEqual([
      expect.objectContaining({
        spaceId: f.sharedSpaceId,
        spaceName: "Shared Space",
        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),
      }),
    ]);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
    const second = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    const secondPayload = await second.json<{ data: { spaces: unknown[] } }>();
    expect(secondPayload.data.spaces).toEqual([]);
  });

  it("intersects cross-Space discovery with the current Agent Delegation", async () => {
    const f = await fixture();
    await f.db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_shared_${crypto.randomUUID().replaceAll("-", "")}`, f.sharedSpaceId, f.userId, "editor", f.now, f.now).run();

    const delegationId = `dlg_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.batch([
      f.db.prepare(`INSERT INTO agent_delegations(
        id,principal_user_id,agent_id,application_id,source_space_id,created_by_user_id,created_at,expires_at,revoked_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
        delegationId,
        f.userId,
        f.agentId,
        f.clientId,
        f.sharedSpaceId,
        f.userId,
        f.now,
        null,
        null,
      ),
      f.db.prepare(`INSERT INTO agent_delegation_models(delegation_id,model_key,max_access)
        VALUES(?,?,?)`).bind(delegationId, f.modelKey, "read"),
    ]);

    const accessToken = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write"],
      { id: f.agentId },
    );
    const first = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    const firstPayload = await first.json<{ data: { spaces: Array<{ spaceId: string; models: Array<{ key: string; access: string[] }> }> } }>();
    expect(firstPayload.data.spaces).toEqual([
      expect.objectContaining({
        spaceId: f.sharedSpaceId,
        spaceName: "Shared Space",
        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),
      }),
    ]);

    await f.db.prepare("UPDATE agent_delegations SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), delegationId).run();
    const second = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    const secondPayload = await second.json<{ data: { spaces: unknown[] } }>();
    expect(secondPayload.data.spaces).toEqual([]);
  });
});
