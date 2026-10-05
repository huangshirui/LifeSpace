import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

async function request(path: string, options: RequestInit = {}) {
  return createApp().request(`http://identity.test${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    BOOTSTRAP_SECRET: "bootstrap-test",
    CORE_IDENTITY_SHARED_SECRET: "core-secret",
    ENVIRONMENT: "test",
  });
}

async function bootstrap(appId: string) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: appId,
      name: appId,
      clientType: "service",
      trustedBackend: true,
      allowedScopes: ["resources:read", "resources:write"],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

async function createAgent(secret: string) {
  const response = await request("/internal/v1/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Adapter Agent" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.id as string;
}

async function introspect(token: string) {
  const response = await request("/introspection/v1/agent-credentials", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-lifespace-internal-secret": "core-secret" },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as any).data;
}

describe("Agent API credential lifecycle", () => {
  it("issues lsp_agt once, narrows scopes and revokes immediately with current Agent/Application state", async () => {
    const appId = `agent-credential-${crypto.randomUUID()}`;
    const secret = await bootstrap(appId);
    const agentId = await createAgent(secret);

    const createdResponse = await request(`/internal/v1/agents/${agentId}/api-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "n8n", scopes: ["resources:read", "resources:write"] }),
    });
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as any).data;
    expect(created.id).toMatch(/^agc_/);
    expect(created.token).toMatch(/^lsp_agt_/);
    expect(created.scopes).toEqual(["resources:read", "resources:write"]);

    const list = await request(`/internal/v1/agents/${agentId}/api-credentials`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as any).data[0];
    expect(listed.id).toBe(created.id);
    expect(listed.token).toBeUndefined();

    const active = await introspect(created.token);
    expect(active).toMatchObject({
      active: true,
      audience: "lifespace-core",
      principal: {
        type: "agent",
        id: agentId,
        clientId: appId,
        scopes: ["resources:read", "resources:write"],
        tokenId: created.id,
        purpose: "agent_api",
      },
    });
    expect(active.principal.actor).toBeUndefined();

    const reduced = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["resources:read"] }),
    });
    expect(reduced.status).toBe(200);
    expect((await introspect(created.token)).principal.scopes).toEqual(["resources:read"]);

    const expansion = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["resources:read", "resources:write"] }),
    });
    expect(expansion.status).toBe(422);

    await (env as unknown as TestEnv).DB.prepare("UPDATE agents SET status='disabled' WHERE id=?").bind(agentId).run();
    expect((await introspect(created.token)).active).toBe(false);
    await (env as unknown as TestEnv).DB.prepare("UPDATE agents SET status='active' WHERE id=?").bind(agentId).run();
    expect((await introspect(created.token)).active).toBe(true);

    const revoked = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoked.status).toBe(204);
    expect((await introspect(created.token)).active).toBe(false);
  });
});
