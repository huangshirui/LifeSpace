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

async function bootstrapApplication(
  pair: Awaited<ReturnType<typeof keys>>,
  applicationId: string,
  allowedScopes: string[],
  trustedBackend = true,
) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: applicationId,
      name: applicationId,
      clientType: "web",
      trustedBackend,
      allowedScopes,
      accessTokenTtlSeconds: 900,
    }),
  }, pair);
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string | undefined;
}

async function provisionConsole(pair: Awaited<ReturnType<typeof keys>>, scopes: string[]) {
  const applicationId = `app_console_agent_admin_${crypto.randomUUID().replaceAll("-", "")}`;
  const secret = await bootstrapApplication(pair, applicationId, scopes, true);
  expect(secret).toMatch(/^lsa_/u);
  const user = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Agent Admin Operator" }),
  }, pair);
  expect(user.status).toBe(201);
  const userId = ((await user.json()) as any).data.id as string;
  expect((await request(`/bootstrap/v1/platform-administrators/${userId}`, {
    method: "PUT",
    headers: { "x-bootstrap-secret": "bootstrap-test" },
  }, pair)).status).toBe(200);
  const session = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: [] }),
  }, pair);
  const sessionToken = ((await session.json()) as any).data.accessToken as string;
  const proof = await request("/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  }, pair);
  expect(proof.status).toBe(200);
  return {
    secret: secret as string,
    userId,
    actorToken: ((await proof.json()) as any).data.actorToken as string,
  };
}

function adminHeaders(secret: string, actorToken: string, json = false) {
  return {
    authorization: `Bearer ${secret}`,
    "x-lifespace-actor-token": actorToken,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

describe("Identity cross-application Platform Agent Admin", () => {
  it("creates, lists, disables and reactivates an Agent identity with human audit attribution", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair, ["platform:admin", "applications:manage", "audit:read"]);
    const targetId = `agent-target-${crypto.randomUUID().replaceAll("-", "")}`;
    await bootstrapApplication(pair, targetId, ["profile:read"], true);

    const createdResponse = await request(`/internal/v1/platform-admin/applications/${targetId}/agents`, {
      method: "POST",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ displayName: "Scheduling Assistant" }),
    }, pair);
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json() as any).data;
    expect(created.id).toMatch(/^agt_/u);
    expect(created).toMatchObject({
      applicationId: targetId,
      displayName: "Scheduling Assistant",
      status: "active",
      binding: { status: "active", revokedAt: null },
    });

    const listed = await request(`/internal/v1/platform-admin/applications/${targetId}/agents`, {
      method: "GET",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, displayName: "Scheduling Assistant", status: "active" }),
    ]));

    const disabled = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}`, {
      method: "PATCH",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ displayName: "Scheduling Assistant", status: "disabled" }),
    }, pair);
    expect(disabled.status).toBe(200);
    expect((await disabled.json() as any).data.status).toBe("disabled");

    const reactivated = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}`, {
      method: "PATCH",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ displayName: "Scheduling Assistant", status: "active" }),
    }, pair);
    expect(reactivated.status).toBe(200);
    expect((await reactivated.json() as any).data.status).toBe("active");

    const binding = await (env as unknown as TestEnv).DB.prepare(
      "SELECT status,revoked_at revokedAt FROM agent_applications WHERE agent_id=? AND application_id=?",
    ).bind(created.id, targetId).first<{ status: string; revokedAt: string | null }>();
    expect(binding).toEqual({ status: "active", revokedAt: null });

    const audit = await request("/internal/v1/platform-admin/audit?limit=50", {
      method: "GET",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(audit.status).toBe(200);
    const entries = (await audit.json() as any).data as any[];
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "agent.create", actorUserId: console.userId, targetId: created.id }),
      expect.objectContaining({ operation: "agent.update", actorUserId: console.userId, targetId: created.id }),
    ]));
    expect(JSON.stringify(entries)).toContain('"authorityGranted":false');
    expect(JSON.stringify(entries)).toContain('"delegationCreated":false');
  });

  it("denies Agent governance without applications:manage and rejects non-trusted targets", async () => {
    const pair = await keys();
    const deniedConsole = await provisionConsole(pair, ["platform:admin"]);
    const trustedTarget = `agent-target-denied-${crypto.randomUUID().replaceAll("-", "")}`;
    await bootstrapApplication(pair, trustedTarget, [], true);
    const denied = await request(`/internal/v1/platform-admin/applications/${trustedTarget}/agents`, {
      method: "GET",
      headers: adminHeaders(deniedConsole.secret, deniedConsole.actorToken),
    }, pair);
    expect(denied.status).toBe(403);

    const console = await provisionConsole(pair, ["platform:admin", "applications:manage"]);
    const browserOnlyTarget = `agent-target-browser-${crypto.randomUUID().replaceAll("-", "")}`;
    await bootstrapApplication(pair, browserOnlyTarget, [], false);
    const rejected = await request(`/internal/v1/platform-admin/applications/${browserOnlyTarget}/agents`, {
      method: "POST",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ displayName: "Should Not Exist" }),
    }, pair);
    expect(rejected.status).toBe(409);
  });
});
