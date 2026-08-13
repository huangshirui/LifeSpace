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

  it("rotates trusted application credentials with overlap and immediate revocation", async () => {
    const privateKey = await privateKeyPem();
    const appId = `rotate-${crypto.randomUUID()}`;
    const bootstrapHeaders = { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" };
    const bootstrap = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({
        id: appId,
        name: "Rotation Test",
        clientType: "mini_program",
        trustedBackend: true,
        allowedScopes: ["spaces:read"],
        accessTokenTtlSeconds: 900,
      }),
    }, privateKey);
    expect(bootstrap.status).toBe(201);
    const oldSecret = ((await bootstrap.json()) as any).data.clientSecret as string;

    const metadata = await request(`/bootstrap/v1/applications/${appId}`, {
      method: "GET",
      headers: { "x-bootstrap-secret": "bootstrap-test" },
    }, privateKey);
    expect(metadata.status).toBe(200);
    expect((await metadata.json() as any).data).toMatchObject({
      id: appId,
      clientType: "mini_program",
      allowedScopes: ["spaces:read"],
      trustedBackend: true,
      accessTokenTtlSeconds: 900,
      status: "active",
    });

    const updated = await request(`/bootstrap/v1/applications/${appId}`, {
      method: "PATCH",
      headers: bootstrapHeaders,
      body: JSON.stringify({ allowedScopes: ["spaces:read", "spaces:write"], accessTokenTtlSeconds: 1200 }),
    }, privateKey);
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data).toMatchObject({
      allowedScopes: ["spaces:read", "spaces:write"],
      accessTokenTtlSeconds: 1200,
    });

    const user = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: `Bearer ${oldSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Rotating User" }),
    }, privateKey);
    expect(user.status).toBe(201);
    const userId = ((await user.json()) as any).data.id as string;

    const replacement = await request(`/bootstrap/v1/applications/${appId}/credentials`, {
      method: "POST",
      headers: { "x-bootstrap-secret": "bootstrap-test" },
    }, privateKey);
    expect(replacement.status).toBe(201);
    const replacementData = (await replacement.json() as any).data;
    const newSecret = replacementData.clientSecret as string;
    expect(newSecret.startsWith("lsa_")).toBe(true);
    expect(replacementData.secretSuffix).toBe(newSecret.slice(-8));
    expect(replacementData.secretHash).toBeUndefined();

    const credentials = await request(`/bootstrap/v1/applications/${appId}/credentials`, {
      method: "GET",
      headers: { "x-bootstrap-secret": "bootstrap-test" },
    }, privateKey);
    expect(credentials.status).toBe(200);
    const credentialList = (await credentials.json() as any).data as Array<Record<string, any>>;
    expect(credentialList).toHaveLength(2);
    expect(credentialList.every((item) => item.clientSecret === undefined && item.secretHash === undefined)).toBe(true);
    const oldCredential = credentialList.find((item) => item.secretSuffix === oldSecret.slice(-8));
    expect(oldCredential?.id).toMatch(/^apc_/);

    const storedReplacement = await (env as unknown as TestEnv).DB.prepare(
      `SELECT secret_hash secretHash FROM application_credentials WHERE id=?`,
    ).bind(replacementData.id).first<{ secretHash: string }>();
    expect(storedReplacement?.secretHash).toBeTruthy();
    expect(storedReplacement?.secretHash).not.toBe(newSecret);

    for (const secret of [oldSecret, newSecret]) {
      const issue = await request("/internal/v1/tokens", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ subjectId: userId, scopes: ["spaces:write"] }),
      }, privateKey);
      expect(issue.status).toBe(200);
      expect((await issue.json() as any).data.expiresIn).toBe(1200);
    }

    const revoke = await request(`/bootstrap/v1/applications/${appId}/credentials/${oldCredential!.id}`, {
      method: "DELETE",
      headers: { "x-bootstrap-secret": "bootstrap-test" },
    }, privateKey);
    expect(revoke.status).toBe(204);

    const oldAfterRevoke = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${oldSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, scopes: ["spaces:read"] }),
    }, privateKey);
    expect(oldAfterRevoke.status).toBe(401);

    const newAfterRevoke = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${newSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, scopes: ["spaces:read"] }),
    }, privateKey);
    expect(newAfterRevoke.status).toBe(200);
  });
});
