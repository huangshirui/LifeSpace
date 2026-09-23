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

async function bootstrapApp(privateKey: string, appId: string) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: appId,
      name: appId,
      clientType: "service",
      trustedBackend: true,
      allowedScopes: ["resources:read", "resources:write"],
      accessTokenTtlSeconds: 3600,
    }),
  }, privateKey);
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

describe("Agent Identity and execution credential", () => {
  it("registers an app-bound Agent and signs a Core-only delegated execution token", async () => {
    const privateKey = await privateKeyPem();
    const appId = `agent-app-${crypto.randomUUID()}`;
    const secret = await bootstrapApp(privateKey, appId);

    const user = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Agent Principal" }),
    }, privateKey);
    expect(user.status).toBe(201);
    const userId = ((await user.json()) as any).data.id as string;

    const created = await request("/internal/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Test Agent" }),
    }, privateKey);
    expect(created.status).toBe(201);
    const agent = ((await created.json()) as any).data;
    expect(agent.id).toMatch(/^agt_/);

    const list = await request("/internal/v1/agents", {
      headers: { authorization: `Bearer ${secret}` },
    }, privateKey);
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).data.items.map((item: any) => item.id)).toContain(agent.id);

    const tokenResponse = await request("/internal/v1/agent-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, agentId: agent.id, scopes: ["resources:read", "resources:write"] }),
    }, privateKey);
    expect(tokenResponse.status).toBe(200);
    const tokenData = ((await tokenResponse.json()) as any).data;
    expect(tokenData.expiresIn).toBe(900);
    expect(tokenData).toMatchObject({
      principalId: userId,
      actor: { type: "agent", id: agent.id },
      applicationId: appId,
    });

    const payload = decodePayload(tokenData.accessToken);
    expect(payload).toMatchObject({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: userId,
      azp: appId,
      principal_type: "user",
      actor_type: "agent",
      actor_id: agent.id,
      purpose: "delegated_agent",
      scope: "resources:read resources:write",
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);

    const escalation = await request("/internal/v1/agent-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, agentId: agent.id, scopes: ["resources:manage"] }),
    }, privateKey);
    expect(escalation.status).toBe(403);

    const otherAppSecret = await bootstrapApp(privateKey, `other-app-${crypto.randomUUID()}`);
    const crossApp = await request("/internal/v1/agent-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${otherAppSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: userId, agentId: agent.id, scopes: ["resources:read"] }),
    }, privateKey);
    expect(crossApp.status).toBe(403);
  });
});
