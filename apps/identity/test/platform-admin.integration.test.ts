import { env } from "cloudflare:workers";
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

async function request(path: string, options: RequestInit, pair: Awaited<ReturnType<typeof keys>>) {
  return createApp().request(`http://localhost${path}`, options, {
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
      clientType: "web",
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

  const actor = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: ["platform:admin"] }),
  }, pair);
  expect(actor.status).toBe(200);
  const actorToken = ((await actor.json()) as any).data.accessToken as string;
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
        clientType: "web",
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

  it("creates and manages applications without bootstrap authority and writes audit evidence", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);

    const create = await request("/internal/v1/platform-admin/applications", {
      method: "POST",
      headers: { ...adminHeaders(console.applicationSecret, console.actorToken), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Managed Web App",
        clientType: "web",
        trustedBackend: true,
        allowedScopes: ["profile:read"],
        accessTokenTtlSeconds: 900,
      }),
    }, pair);
    expect(create.status).toBe(201);
    const created = (await create.json() as any).data;
    expect(created.id).toMatch(/^app_/u);
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
});
