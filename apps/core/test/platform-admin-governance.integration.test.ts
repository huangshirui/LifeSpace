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

async function principalToken(privateKey: string, type: "user" | "service", id: string, clientId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: id,
    azp: clientId,
    principal_type: type,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function adminActor(privateKey: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "platform:admin",
    purpose: "platform_admin_actor",
    iat,
    exp: iat + 300,
    jti: `pad_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
  return { token, userId };
}

async function call(
  publicKey: string,
  executor: string,
  actor: string | null,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return createApp().request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${executor}`,
      ...(actor ? { "x-lifespace-actor-token": actor } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

describe("Core Platform Admin governance", () => {
  it("creates, updates and revokes the authoritative Data Grant without Space membership", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const executorId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await principalToken(pair.privateKey, "service", executorId, clientId, ["grants:manage", "spaces:inspect"]);
    const actor = await adminActor(pair.privateKey, clientId);
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const targetServiceId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();

    await (env as unknown as TestEnv).DB.prepare(
      "INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)",
    ).bind(spaceId, "Platform governed", ownerId, createdAt, createdAt, "Asia/Tokyo").run();

    const created = await call(pair.publicKey, executor, actor.token, `/api/v1/platform-admin/spaces/${spaceId}/grants`, {
      method: "POST",
      body: { granteeType: "service", granteeId: targetServiceId, resourceType: "space", permission: "read", expiresAt: null },
    });
    expect(created.status).toBe(201);
    const grant = (await created.json() as any).data;
    expect(grant).toMatchObject({ sourceSpaceId: spaceId, granteeType: "service", granteeId: targetServiceId, permission: "read", createdByUserId: actor.userId });

    const membership = await (env as unknown as TestEnv).DB.prepare(
      "SELECT id FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL",
    ).bind(spaceId, actor.userId).first();
    expect(membership).toBeNull();

    const updated = await call(pair.publicKey, executor, actor.token, `/api/v1/platform-admin/spaces/${spaceId}/grants/${grant.id}`, {
      method: "PATCH",
      body: { permission: "write" },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data.permission).toBe("write");

    const revoked = await call(pair.publicKey, executor, actor.token, `/api/v1/platform-admin/spaces/${spaceId}/grants/${grant.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    const stored = await (env as unknown as TestEnv).DB.prepare("SELECT permission,revoked_at FROM data_grants WHERE id=?").bind(grant.id).first<{permission:string; revoked_at:string|null}>();
    expect(stored?.permission).toBe("write");
    expect(stored?.revoked_at).toBeTruthy();

    const audits = await (env as unknown as TestEnv).DB.prepare(
      "SELECT operation,actor_user_id,executor_principal_id,result FROM platform_admin_audit WHERE target_id=? ORDER BY created_at",
    ).bind(grant.id).all<{ operation: string; actor_user_id: string; executor_principal_id: string; result: string }>();
    expect(audits.results.map((row) => row.operation)).toEqual(["data_grant.create", "data_grant.update", "data_grant.revoke"]);
    expect(audits.results.every((row) => row.actor_user_id === actor.userId && row.executor_principal_id === executorId && row.result === "success")).toBe(true);
  });

  it("requires both grant executor scope and platform-admin actor proof", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();
    await (env as unknown as TestEnv).DB.prepare(
      "INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)",
    ).bind(spaceId, "Denied platform grant", ownerId, createdAt, createdAt, "UTC").run();

    const actor = await adminActor(pair.privateKey, clientId);
    const withoutScope = await principalToken(pair.privateKey, "service", `svc_${crypto.randomUUID().replaceAll("-", "")}`, clientId, ["spaces:inspect"]);
    const deniedScope = await call(pair.publicKey, withoutScope, actor.token, `/api/v1/platform-admin/spaces/${spaceId}/grants`, {
      method: "POST",
      body: { granteeType: "service", granteeId: `svc_${crypto.randomUUID().replaceAll("-", "")}`, permission: "read" },
    });
    expect(deniedScope.status).toBe(403);

    const executor = await principalToken(pair.privateKey, "service", `svc_${crypto.randomUUID().replaceAll("-", "")}`, clientId, ["grants:manage"]);
    const deniedActor = await call(pair.publicKey, executor, null, `/api/v1/platform-admin/spaces/${spaceId}/grants`, {
      method: "POST",
      body: { granteeType: "service", granteeId: `svc_${crypto.randomUUID().replaceAll("-", "")}`, permission: "read" },
    });
    expect(deniedActor.status).toBe(401);
  });

  it("keeps ordinary Space Grant management user-only even when a service has grants:manage", async () => {
    const pair = await keys();
    const clientId = `app_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await principalToken(pair.privateKey, "service", `svc_${crypto.randomUUID().replaceAll("-", "")}`, clientId, ["grants:manage"]);
    const denied = await call(pair.publicKey, executor, null, `/api/v1/spaces/spc_${crypto.randomUUID().replaceAll("-", "")}/grants`, {
      method: "POST",
      body: { granteeType: "service", granteeId: `svc_${crypto.randomUUID().replaceAll("-", "")}`, permission: "read" },
    });
    expect(denied.status).toBe(403);
  });

  it("uses the Platform Admin namespace for Console model inspection while preserving service Model Control Plane", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const serviceId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await principalToken(pair.privateKey, "service", serviceId, clientId, ["models:manage"]);
    const actor = await adminActor(pair.privateKey, clientId);

    const platformList = await call(pair.publicKey, executor, actor.token, "/api/v1/platform-admin/models");
    expect(platformList.status).toBe(200);
    expect(Array.isArray((await platformList.json() as any).data)).toBe(true);

    const missingActor = await call(pair.publicKey, executor, null, "/api/v1/platform-admin/models");
    expect(missingActor.status).toBe(401);

    const automationList = await call(pair.publicKey, executor, null, "/api/v1/model-admin/models");
    expect(automationList.status).toBe(200);
    expect(Array.isArray((await automationList.json() as any).data)).toBe(true);
  });
});
