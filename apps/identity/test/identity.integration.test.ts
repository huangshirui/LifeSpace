import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function privateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
}

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(normalized));
}

async function request(path: string, options: RequestInit, privateKey: string) {
  return createApp().request(`http://localhost${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    BOOTSTRAP_SECRET: "bootstrap-test",
    TOKEN_PRIVATE_KEY: privateKey,
    ENVIRONMENT: "test",
  });
}

describe("D1-backed Identity trust flow", () => {
  it("stores only application credential hashes and applies per-app token TTL", async () => {
    const privateKey = await privateKeyPem();
    const appId = `homemew-test-${crypto.randomUUID()}`;
    const bootstrap = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
      body: JSON.stringify({
        id: appId,
        name: "HomeMew Test",
        clientType: "mini_program",
        trustedBackend: true,
        allowedScopes: ["spaces:read", "spaces:write"],
        accessTokenTtlSeconds: 3600,
      }),
    }, privateKey);
    expect(bootstrap.status).toBe(201);
    const bootstrapBody = await bootstrap.json() as any;
    const secret = bootstrapBody.data.clientSecret as string;
    expect(secret.startsWith("lsa_")).toBe(true);
    expect(bootstrapBody.data.accessTokenTtlSeconds).toBe(3600);

    const stored = await (env as unknown as TestEnv).DB.prepare(
      `SELECT secret_hash secretHash, secret_suffix secretSuffix FROM application_credentials WHERE application_id=?`,
    ).bind(appId).first<{ secretHash: string; secretSuffix: string }>();
    expect(stored).toBeTruthy();
    expect(stored!.secretHash).not.toBe(secret);
    expect(stored!.secretSuffix).toBe(secret.slice(-8));

    const createUser = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Test User" }),
    }, privateKey);
    expect(createUser.status).toBe(201);
    const userId = ((await createUser.json()) as any).data.id as string;

    const issue = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, scopes: ["spaces:read"] }),
    }, privateKey);
    expect(issue.status).toBe(200);
    const issued = (await issue.json()) as any;
    expect(issued.data.expiresIn).toBe(3600);
    const payload = decodePayload(issued.data.accessToken);
    expect(payload.azp).toBe(appId);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("rejects invalid credentials, scope escalation and disabled users", async () => {
    const privateKey = await privateKeyPem();
    const appId = `app-${crypto.randomUUID()}`;
    const bootstrap = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
      body: JSON.stringify({ id: appId, name: "Test App", clientType: "service", trustedBackend: true, allowedScopes: ["spaces:read"] }),
    }, privateKey);
    const secret = ((await bootstrap.json()) as any).data.clientSecret as string;

    const badCredential = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: "Bearer lsa_invalid_invalid_invalid_invalid_invalid_invalid", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Denied" }),
    }, privateKey);
    expect(badCredential.status).toBe(401);

    const createUser = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Scoped User" }),
    }, privateKey);
    const userId = ((await createUser.json()) as any).data.id as string;

    const escalation = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, scopes: ["spaces:write"] }),
    }, privateKey);
    expect(escalation.status).toBe(403);

    await (env as unknown as TestEnv).DB.prepare(`UPDATE users SET status='disabled' WHERE id=?`).bind(userId).run();
    const disabled = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, scopes: ["spaces:read"] }),
    }, privateKey);
    expect(disabled.status).toBe(403);
  });
});
