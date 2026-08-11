import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
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

async function token(privateKey: string, type: "user" | "service", scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: `${type}_${crypto.randomUUID().replaceAll("-", "")}`,
    azp: "lifespace-platform-admin",
    principal_type: type,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function call(publicKey: string, accessToken: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

function definition() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return {
    definitionVersion: 1,
    key: `journal_${suffix}`,
    route: `journals-${suffix}`,
    display: { singular: "Journal", plural: "Journals" },
    fields: { title: { type: "string", required: true, maxLength: 120 } },
    query: { searchable: ["title"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

describe("Model Admin API", () => {
  it("requires a service principal even when a user token has models:manage", async () => {
    const pair = await keys();
    const userToken = await token(pair.privateKey, "user", ["models:manage"]);
    const response = await call(pair.publicKey, userToken, "/api/v1/model-admin/models");
    expect(response.status).toBe(403);

    const contractsResponse = await call(pair.publicKey, userToken, "/api/v1/model-admin/contracts/active");
    expect(contractsResponse.status).toBe(403);
  });

  it("validates/publishes a model and advances an immutable contract revision", async () => {
    const pair = await keys();
    const serviceToken = await token(pair.privateKey, "service", ["models:manage"]);
    const model = definition();

    const initialContractResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/contracts/active");
    expect(initialContractResponse.status).toBe(200);
    const initialContract = await initialContractResponse.json<{ data: { id: string; registryRevision: number; manifest: { models: Array<{ key: string }> } } }>();
    expect(initialContract.data.id).toMatch(/^mct_[a-f0-9]{64}$/u);

    const validateResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/models/validate", {
      method: "POST",
      body: JSON.stringify({ definition: model }),
    });
    expect(validateResponse.status).toBe(200);
    const validation = await validateResponse.json<{ data: { valid: boolean; schemaHash?: string } }>();
    expect(validation.data.valid).toBe(true);
    expect(validation.data.schemaHash).toMatch(/^[a-f0-9]{64}$/u);

    const publishResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/models", {
      method: "POST",
      body: JSON.stringify({ definition: model, compatibility: "initial" }),
    });
    expect(publishResponse.status).toBe(201);
    const published = await publishResponse.json<{ data: { key: string; version: number; schemaHash: string } }>();
    expect(published.data).toMatchObject({ key: model.key, version: 1 });

    const activeContractResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/contracts/active");
    expect(activeContractResponse.status).toBe(200);
    const activeContract = await activeContractResponse.json<{ data: { id: string; registryRevision: number; manifest: { models: Array<{ key: string }> } } }>();
    expect(activeContract.data.id).not.toBe(initialContract.data.id);
    expect(activeContract.data.registryRevision).toBe(initialContract.data.registryRevision + 1);
    expect(activeContract.data.manifest.models.some((entry) => entry.key === model.key)).toBe(true);

    const historicalResponse = await call(pair.publicKey, serviceToken, `/api/v1/model-admin/contracts/${initialContract.data.id}`);
    expect(historicalResponse.status).toBe(200);
    const historical = await historicalResponse.json<{ data: { id: string } }>();
    expect(historical.data.id).toBe(initialContract.data.id);

    const getResponse = await call(pair.publicKey, serviceToken, `/api/v1/model-admin/models/${model.key}`);
    expect(getResponse.status).toBe(200);

    const retireResponse = await call(pair.publicKey, serviceToken, `/api/v1/model-admin/models/${model.key}/retire`, { method: "POST" });
    expect(retireResponse.status).toBe(204);

    const afterRetireResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/contracts/active");
    expect(afterRetireResponse.status).toBe(200);
    const afterRetire = await afterRetireResponse.json<{ data: { registryRevision: number; manifest: { models: Array<{ key: string }> } } }>();
    expect(afterRetire.data.registryRevision).toBe(activeContract.data.registryRevision + 1);
    expect(afterRetire.data.manifest.models.some((entry) => entry.key === model.key)).toBe(false);

    const missingResponse = await call(pair.publicKey, serviceToken, `/api/v1/model-admin/models/${model.key}`);
    expect(missingResponse.status).toBe(404);
  });
});
