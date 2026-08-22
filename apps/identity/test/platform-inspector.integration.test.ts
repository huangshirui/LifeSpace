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

async function provision(pair: Awaited<ReturnType<typeof keys>>) {
  const appId = `app_console_inspector_${crypto.randomUUID().replaceAll("-", "")}`;
  const bootstrap = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: appId,
      name: "Inspector Console",
      clientType: "web",
      trustedBackend: true,
      allowedScopes: ["platform:admin", "identities:read"],
      accessTokenTtlSeconds: 900,
    }),
  }, pair);
  expect(bootstrap.status).toBe(201);
  const secret = ((await bootstrap.json()) as any).data.clientSecret as string;
  const user = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Inspector Operator" }),
  }, pair);
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
  return { appId, secret, userId, actorToken };
}

function headers(secret: string, actorToken: string) {
  return { authorization: `Bearer ${secret}`, "x-lifespace-actor-token": actorToken };
}

describe("Identity Platform Inspector", () => {
  it("lists global users and exposes linked Access principals as read-only metadata", async () => {
    const pair = await keys();
    const console = await provision(pair);
    const targetId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    await (env as unknown as TestEnv).DB.batch([
      (env as unknown as TestEnv).DB.prepare("INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)")
        .bind(targetId, "Linked User", "active", timestamp, timestamp),
      (env as unknown as TestEnv).DB.prepare(`INSERT INTO access_principals(
        id,issuer,subject,user_id,email_snapshot,status,linked_at,last_seen_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
        `acp_${crypto.randomUUID().replaceAll("-", "")}`,
        "https://example.cloudflareaccess.com",
        `sub_${crypto.randomUUID().replaceAll("-", "")}`,
        targetId,
        "linked@example.com",
        "active",
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ),
    ]);

    const list = await request(`/internal/v1/platform-admin/users?q=${encodeURIComponent("Linked User")}`, {
      method: "GET",
      headers: headers(console.secret, console.actorToken),
    }, pair);
    expect(list.status).toBe(200);
    expect((await list.json() as any).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: targetId, displayName: "Linked User" })]));

    const detail = await request(`/internal/v1/platform-admin/users/${targetId}`, {
      method: "GET",
      headers: headers(console.secret, console.actorToken),
    }, pair);
    expect(detail.status).toBe(200);
    const payload = (await detail.json() as any).data;
    expect(payload).toMatchObject({ id: targetId, displayName: "Linked User" });
    expect(payload.accessPrincipals).toHaveLength(1);
    expect(payload.accessPrincipals[0]).toMatchObject({ userId: targetId, emailSnapshot: "linked@example.com", status: "active" });
  });

  it("rejects inspector access when the Console executor lacks identities:read", async () => {
    const pair = await keys();
    const console = await provision(pair);
    await (env as unknown as TestEnv).DB.prepare("UPDATE applications SET allowed_scopes=? WHERE id=?")
      .bind(JSON.stringify(["platform:admin"]), console.appId).run();
    const denied = await request("/internal/v1/platform-admin/users", {
      method: "GET",
      headers: headers(console.secret, console.actorToken),
    }, pair);
    expect(denied.status).toBe(403);
  });
});
