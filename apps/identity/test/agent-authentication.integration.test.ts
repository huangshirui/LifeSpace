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
      trustedBackend: true,
      allowedScopes: ["resources:read", "resources:write"],
      accessTokenTtlSeconds: 3600,
    }),
  }, privateKey);
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

describe("Agent Identity and execution credential", () => {
  it("registers an app-bound Agent and signs a represented User Agent execution token", async () => {
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

    const tokenResponse = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "user",
        principalId: userId,
        agentId: agent.id,
        scopes: ["resources:read", "resources:write"],
      }),
    }, privateKey);
    expect(tokenResponse.status).toBe(200);
    const tokenData = ((await tokenResponse.json()) as any).data;
    expect(tokenData.expiresIn).toBe(900);
    expect(tokenData).toMatchObject({
      principalId: userId,
      principalType: "user",
      actor: { type: "agent", id: agent.id },
      applicationId: appId,
      purpose: "agent_execution",
    });

    const payload = decodePayload(tokenData.accessToken);
    expect(payload).toMatchObject({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: agent.id,
      azp: appId,
      principal_type: "user",
      principal_id: userId,
      actor_type: "agent",
      actor_id: agent.id,
      purpose: "agent_execution",
      scope: "resources:read resources:write",
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);

    const escalation = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "user",
        principalId: userId,
        agentId: agent.id,
        scopes: ["resources:manage"],
      }),
    }, privateKey);
    expect(escalation.status).toBe(403);

    const otherAppSecret = await bootstrapApp(privateKey, `other-app-${crypto.randomUUID()}`);
    const crossApp = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${otherAppSecret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "user",
        principalId: userId,
        agentId: agent.id,
        scopes: ["resources:read"],
      }),
    }, privateKey);
    expect(crossApp.status).toBe(403);
  });

  it("issues direct and represented Agent execution tokens through one contract", async () => {
    const privateKey = await privateKeyPem();
    const appId = `agent-generalized-${crypto.randomUUID()}`;
    const secret = await bootstrapApp(privateKey, appId);

    const userResponse = await request("/internal/v1/users", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Generalized Principal" }),
    }, privateKey);
    expect(userResponse.status).toBe(201);
    const userId = ((await userResponse.json()) as any).data.id as string;

    const createAgent = async (displayName: string) => {
      const response = await request("/internal/v1/agents", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      }, privateKey);
      expect(response.status).toBe(201);
      return ((await response.json()) as any).data.id as string;
    };

    const agentA = await createAgent("Agent A");
    const agentB = await createAgent("Agent B");

    const directResponse = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: agentA, scopes: ["resources:read"] }),
    }, privateKey);
    expect(directResponse.status).toBe(200);
    const direct = ((await directResponse.json()) as any).data;
    expect(direct).toMatchObject({
      principalId: agentA,
      principalType: "agent",
      actor: { type: "agent", id: agentA },
      applicationId: appId,
      purpose: "agent_execution",
    });
    expect(decodePayload(direct.accessToken)).toMatchObject({
      sub: agentA,
      azp: appId,
      principal_type: "agent",
      principal_id: agentA,
      actor_type: "agent",
      actor_id: agentA,
      purpose: "agent_execution",
    });

    const representedAgentResponse = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "agent",
        principalId: agentA,
        agentId: agentB,
        scopes: ["resources:read", "resources:write"],
      }),
    }, privateKey);
    expect(representedAgentResponse.status).toBe(200);
    const representedAgent = ((await representedAgentResponse.json()) as any).data;
    expect(representedAgent).toMatchObject({
      principalId: agentA,
      principalType: "agent",
      actor: { type: "agent", id: agentB },
      purpose: "agent_execution",
    });
    expect(decodePayload(representedAgent.accessToken)).toMatchObject({
      sub: agentB,
      principal_type: "agent",
      principal_id: agentA,
      actor_type: "agent",
      actor_id: agentB,
      purpose: "agent_execution",
    });

    const representedUserResponse = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "user",
        principalId: userId,
        agentId: agentA,
        scopes: ["resources:read"],
      }),
    }, privateKey);
    expect(representedUserResponse.status).toBe(200);
    expect(decodePayload(((await representedUserResponse.json()) as any).data.accessToken)).toMatchObject({
      sub: agentA,
      principal_type: "user",
      principal_id: userId,
      actor_type: "agent",
      actor_id: agentA,
      purpose: "agent_execution",
    });

    const partialPrincipal = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ principalType: "user", agentId: agentA, scopes: ["resources:read"] }),
    }, privateKey);
    expect(partialPrincipal.status).toBe(400);

    const unsupportedPrincipalType = await request("/internal/v1/agent-execution-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "service",
        principalId: "svc_not_enabled_for_agent_execution",
        agentId: agentA,
        scopes: ["resources:read"],
      }),
    }, privateKey);
    expect(unsupportedPrincipalType.status).toBe(422);
  });
});
