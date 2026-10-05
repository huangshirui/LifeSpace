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
  name: string,
  allowedScopes: string[],
) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: applicationId,
      name,
      clientType: "web",
      trustedBackend: true,
      allowedScopes,
      accessTokenTtlSeconds: 900,
    }),
  }, pair);
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

async function provisionConsole(pair: Awaited<ReturnType<typeof keys>>, scopes: string[]) {
  const applicationId = `app_console_service_admin_${crypto.randomUUID().replaceAll("-", "")}`;
  const secret = await bootstrapApplication(pair, applicationId, "Console Service Admin", scopes);
  const user = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Service Admin Operator" }),
  }, pair);
  expect(user.status).toBe(201);
  const userId = ((await user.json()) as any).data.id as string;

  const assignment = await request(`/bootstrap/v1/platform-administrators/${userId}`, {
    method: "PUT",
    headers: { "x-bootstrap-secret": "bootstrap-test" },
  }, pair);
  expect(assignment.status).toBe(200);

  const session = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: [] }),
  }, pair);
  expect(session.status).toBe(200);
  const sessionToken = ((await session.json()) as any).data.accessToken as string;

  const proof = await request("/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  }, pair);
  expect(proof.status).toBe(200);
  const actorToken = ((await proof.json()) as any).data.actorToken as string;
  return { applicationId, secret, userId, actorToken };
}

function adminHeaders(secret: string, actorToken: string, json = false) {
  return {
    authorization: `Bearer ${secret}`,
    "x-lifespace-actor-token": actorToken,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Identity cross-application Platform Service Admin", () => {
  it("creates and governs a semantic-id target application's service principal and opaque token with human audit attribution", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair, ["platform:admin", "services:manage", "audit:read"]);
    const targetId = `legacy-service-target-${crypto.randomUUID().replaceAll("-", "")}`;
    await bootstrapApplication(pair, targetId, "Target Service App", ["resources:read", "resources:write"]);

    const createPrincipal = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals`, {
      method: "POST",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({
        displayName: "household sync service",
        description: "Console-managed service principal",
        maxScopes: ["resources:read", "resources:write"],
      }),
    }, pair);
    expect(createPrincipal.status).toBe(201);
    const principal = (await createPrincipal.json() as any).data;
    expect(principal).toMatchObject({ applicationId: targetId, status: "active", createdByUserId: console.userId });
    expect(principal.id).toMatch(/^svc_/u);

    const createToken = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens`, {
      method: "POST",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ label: "automation primary", scopes: ["resources:read", "resources:write"] }),
    }, pair);
    expect(createToken.status).toBe(201);
    const createdToken = (await createToken.json() as any).data;
    expect(createdToken.token).toMatch(/^lsp_svc_/u);
    expect(createdToken.createdByUserId).toBe(console.userId);

    const stored = await (env as unknown as TestEnv).DB.prepare(
      "SELECT token_hash tokenHash,revoked_at revokedAt,revoked_by_user_id revokedByUserId FROM service_api_tokens WHERE id=?",
    ).bind(createdToken.id).first<{ tokenHash: string; revokedAt: string | null; revokedByUserId: string | null }>();
    expect(stored?.tokenHash).toBe(await sha256(createdToken.token));
    expect(stored?.tokenHash).not.toBe(createdToken.token);

    const listed = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens`, {
      method: "GET",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(listed.status).toBe(200);
    const tokenList = (await listed.json() as any).data as any[];
    expect(tokenList).toHaveLength(1);
    expect(tokenList[0].token).toBeUndefined();
    expect(tokenList[0].tokenHash).toBeUndefined();

    const reduced = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens/${createdToken.id}`, {
      method: "PATCH",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ scopes: ["resources:read"] }),
    }, pair);
    expect(reduced.status).toBe(200);
    expect((await reduced.json() as any).data.scopes).toEqual(["resources:read"]);

    const expandAgain = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens/${createdToken.id}`, {
      method: "PATCH",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ scopes: ["resources:read", "resources:write"] }),
    }, pair);
    expect(expandAgain.status).toBe(422);

    const disabled = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}`, {
      method: "PATCH",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ status: "disabled" }),
    }, pair);
    expect(disabled.status).toBe(200);

    const tokenWhileDisabled = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens`, {
      method: "POST",
      headers: adminHeaders(console.secret, console.actorToken, true),
      body: JSON.stringify({ label: "denied", scopes: ["resources:read"] }),
    }, pair);
    expect(tokenWhileDisabled.status).toBe(409);

    const revoke = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals/${principal.id}/tokens/${createdToken.id}`, {
      method: "DELETE",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(revoke.status).toBe(204);
    const revoked = await (env as unknown as TestEnv).DB.prepare(
      "SELECT revoked_at revokedAt,revoked_by_user_id revokedByUserId FROM service_api_tokens WHERE id=?",
    ).bind(createdToken.id).first<{ revokedAt: string | null; revokedByUserId: string | null }>();
    expect(revoked?.revokedAt).toBeTruthy();
    expect(revoked?.revokedByUserId).toBe(console.userId);

    const audit = await request("/internal/v1/platform-admin/audit?limit=50", {
      method: "GET",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(audit.status).toBe(200);
    const entries = (await audit.json() as any).data as any[];
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "service_principal.create", actorUserId: console.userId, targetId: principal.id }),
      expect.objectContaining({ operation: "service_token.create", actorUserId: console.userId, targetId: createdToken.id }),
      expect.objectContaining({ operation: "service_token.revoke", actorUserId: console.userId, targetId: createdToken.id }),
    ]));
    expect(JSON.stringify(entries)).not.toContain(createdToken.token);
  });

  it("denies cross-application service administration without services:manage", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair, ["platform:admin"]);
    const targetId = `app_service_target_denied_${crypto.randomUUID().replaceAll("-", "")}`;
    await bootstrapApplication(pair, targetId, "Denied Target", ["resources:read"]);

    const denied = await request(`/internal/v1/platform-admin/applications/${targetId}/service-principals`, {
      method: "GET",
      headers: adminHeaders(console.secret, console.actorToken),
    }, pair);
    expect(denied.status).toBe(403);
  });
});
