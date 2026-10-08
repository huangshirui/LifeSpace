import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

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

async function request(path: string, options: RequestInit, pair: Awaited<ReturnType<typeof keys>>) {
  return createIdentityApp().request(`http://localhost${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    BOOTSTRAP_SECRET: "bootstrap-test",
    TOKEN_PRIVATE_KEY: pair.privateKey,
    TOKEN_PUBLIC_KEY: pair.publicKey,
    ENVIRONMENT: "test",
  });
}

async function provisionConsole(pair: Awaited<ReturnType<typeof keys>>) {
  const applicationId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
  const bootstrap = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: applicationId,
      name: "LifeSpace Console Test",
      trustedBackend: true,
      allowedScopes: ["platform:admin", "applications:manage", "audit:read"],
      accessTokenTtlSeconds: 900,
    }),
  }, pair);
  expect(bootstrap.status).toBe(201);
  const applicationSecret = ((await bootstrap.json()) as any).data.clientSecret as string;

  const user = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Console Operator" }),
  }, pair);
  expect(user.status).toBe(201);
  const userId = ((await user.json()) as any).data.id as string;
  const assignedAt = new Date().toISOString();
  await (env as unknown as TestEnv).DB.prepare(`INSERT INTO platform_administrators(user_id,status,assigned_at,revoked_at)
    VALUES(?,'active',?,NULL)`).bind(userId, assignedAt).run();

  const session = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: [] }),
  }, pair);
  expect(session.status).toBe(200);
  const sessionToken = ((await session.json()) as any).data.accessToken as string;

  const actor = await request("/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  }, pair);
  expect(actor.status).toBe(200);
  const actorData = ((await actor.json()) as any).data;
  expect(actorData).toMatchObject({ expiresIn: 300, scope: "platform:admin", purpose: "platform_admin_actor" });
  const actorToken = actorData.actorToken as string;
  return { applicationId, applicationSecret, userId, actorToken };
}

function adminHeaders(secret: string, actorToken?: string) {
  return {
    authorization: `Bearer ${secret}`,
    ...(actorToken ? { "x-lifespace-actor-token": actorToken } : {}),
  };
}

describe("Identity Platform Admin API", () => {
  it("requires both trusted Console application authority and verified same-application user actor proof", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);

    const missingActor = await request("/internal/v1/platform-admin/applications", {
      method: "GET",
      headers: adminHeaders(console.applicationSecret),
    }, pair);
    expect(missingActor.status).toBe(401);

    const noExecutorScopeId = `app_console_no_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    const noExecutorScope = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
      body: JSON.stringify({
        id: noExecutorScopeId,
        name: "No Admin Scope",
        trustedBackend: true,
        allowedScopes: ["platform:admin"],
      }),
    }, pair);
    const noScopeSecret = ((await noExecutorScope.json()) as any).data.clientSecret as string;
    const denied = await request("/internal/v1/platform-admin/applications", {
      method: "GET",
      headers: adminHeaders(noScopeSecret, console.actorToken),
    }, pair);
    expect(denied.status).toBe(403);
  });

  it("rejects an issued actor proof after the user assignment is revoked", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);
    await (env as unknown as TestEnv).DB.prepare("UPDATE platform_administrators SET status='revoked',revoked_at=? WHERE user_id=?")
      .bind(new Date().toISOString(), console.userId).run();

    const denied = await request("/internal/v1/platform-admin/applications", {
      method: "GET",
      headers: adminHeaders(console.applicationSecret, console.actorToken),
    }, pair);
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.code).toBe("PLATFORM_ADMIN_NOT_ASSIGNED");
  });

  it("creates and manages applications without bootstrap authority and writes audit evidence", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);

    const create = await request("/internal/v1/platform-admin/applications", {
      method: "POST",
      headers: { ...adminHeaders(console.applicationSecret, console.actorToken), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Managed Application",
        trustedBackend: true,
        allowedScopes: ["profile:read"],
        accessTokenTtlSeconds: 900,
      }),
    }, pair);
    expect(create.status).toBe(201);
    const created = (await create.json() as any).data;
    expect(created.id).toMatch(/^app_/u);
    expect(created.clientType).toBeUndefined();
    expect(created.clientSecret).toMatch(/^lsa_/u);
    expect(created.credential.secretSuffix).toBe(created.clientSecret.slice(-8));

    const listed = await request("/internal/v1/platform-admin/applications", {
      method: "GET",
      headers: adminHeaders(console.applicationSecret, console.actorToken),
    }, pair);
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).data.some((entry: any) => entry.id === created.id)).toBe(true);

    const credentials = await request(`/internal/v1/platform-admin/applications/${created.id}/credentials`, {
      method: "GET",
      headers: adminHeaders(console.applicationSecret, console.actorToken),
    }, pair);
    expect(credentials.status).toBe(200);
    const credentialList = (await credentials.json() as any).data as any[];
    expect(credentialList).toHaveLength(1);
    expect(credentialList[0].clientSecret).toBeUndefined();
    expect(credentialList[0].secretHash).toBeUndefined();

    const updated = await request(`/internal/v1/platform-admin/applications/${created.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders(console.applicationSecret, console.actorToken), "content-type": "application/json" },
      body: JSON.stringify({ allowedScopes: ["profile:read", "profile:write"], accessTokenTtlSeconds: 1200 }),
    }, pair);
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data).toMatchObject({ allowedScopes: ["profile:read", "profile:write"], accessTokenTtlSeconds: 1200 });

    const audit = await request("/internal/v1/platform-admin/audit?limit=20", {
      method: "GET",
      headers: adminHeaders(console.applicationSecret, console.actorToken),
    }, pair);
    expect(audit.status).toBe(200);
    const entries = (await audit.json() as any).data as any[];
    const createAudit = entries.find((entry) => entry.operation === "application.create" && entry.targetId === created.id);
    expect(createAudit).toMatchObject({ actorUserId: console.userId, executorApplicationId: console.applicationId, result: "success" });
    expect(JSON.stringify(createAudit)).not.toContain(created.clientSecret);
  });

  it("reads and updates an existing semantic application id while new application creation remains app_*", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);
    const applicationId = `legacy-app-${crypto.randomUUID().replaceAll("-", "")}`;
    const existing = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
      body: JSON.stringify({
        id: applicationId,
        name: "Legacy Semantic Application",
        trustedBackend: true,
        allowedScopes: ["profile:read"],
        accessTokenTtlSeconds: 900,
      }),
    }, pair);
    expect(existing.status).toBe(201);

    const read = await request(`/internal/v1/platform-admin/applications/${applicationId}`, {
      method: "GET",
      headers: adminHeaders(console.applicationSecret, console.actorToken),
    }, pair);
    expect(read.status).toBe(200);
    expect((await read.json() as any).data.id).toBe(applicationId);

    const updated = await request(`/internal/v1/platform-admin/applications/${applicationId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(console.applicationSecret, console.actorToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy Semantic Application Updated" }),
    }, pair);
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data).toMatchObject({ id: applicationId, name: "Legacy Semantic Application Updated" });
  });
});