import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

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

async function token(privateKey: string, type: "user" | "service", clientId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: `${type === "user" ? "usr" : "svc"}_${crypto.randomUUID().replaceAll("-", "")}`,
    azp: clientId,
    principal_type: type,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function adminActorToken(privateKey: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: `usr_${crypto.randomUUID().replaceAll("-", "")}`,
    azp: clientId,
    principal_type: "user",
    scope: "platform:admin",
    purpose: "platform_admin_actor",
    iat,
    exp: iat + 300,
    jti: `pad_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function call(publicKey: string, executorToken: string, actorToken: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: {
      authorization: `Bearer ${executorToken}`,
      "x-lifespace-actor-token": actorToken,
    },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

describe("Core Platform Inspector", () => {
  it("reads global Space membership, Grants and record-count summaries without Space membership authority", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await token(pair.privateKey, "service", clientId, ["spaces:inspect"]);
    const actor = await adminActorToken(pair.privateKey, clientId);
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();

    await (env as unknown as TestEnv).DB.batch([
      (env as unknown as TestEnv).DB.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Inspector Space", userId, createdAt, createdAt, "Asia/Shanghai"),
      (env as unknown as TestEnv).DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID().replaceAll("-", "")}`, spaceId, userId, "owner", createdAt, createdAt),
      (env as unknown as TestEnv).DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID().replaceAll("-", "")}`, spaceId, userId, "Owner", createdAt, createdAt),
      (env as unknown as TestEnv).DB.prepare(`INSERT INTO data_grants(
        id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
        `grt_${crypto.randomUUID().replaceAll("-", "")}`,
        spaceId,
        "service",
        `svc_${crypto.randomUUID().replaceAll("-", "")}`,
        "space",
        null,
        "read",
        userId,
        createdAt,
      ),
    ]);

    const list = await call(pair.publicKey, executor, actor, `/api/v1/platform-admin/spaces?q=${encodeURIComponent("Inspector Space")}`);
    expect(list.status).toBe(200);
    expect((await list.json() as any).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: spaceId, name: "Inspector Space", memberCount: 1, grantCount: 1 }),
    ]));

    const detail = await call(pair.publicKey, executor, actor, `/api/v1/platform-admin/spaces/${spaceId}`);
    expect(detail.status).toBe(200);
    const payload = (await detail.json() as any).data;
    expect(payload).toMatchObject({ id: spaceId, name: "Inspector Space", timezone: "Asia/Shanghai" });
    expect(payload.members).toEqual([expect.objectContaining({ userId, displayName: "Owner", role: "owner" })]);
    expect(payload.grants).toEqual([expect.objectContaining({ granteeType: "service", permission: "read" })]);
    expect(payload.recordCounts).toEqual({});
  });

  it("rejects a service executor that lacks spaces:inspect", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await token(pair.privateKey, "service", clientId, ["resources:read"]);
    const actor = await adminActorToken(pair.privateKey, clientId);
    const denied = await call(pair.publicKey, executor, actor, "/api/v1/platform-admin/spaces");
    expect(denied.status).toBe(403);
  });
});