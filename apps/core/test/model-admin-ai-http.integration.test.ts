import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

type PrincipalType = "user" | "service";

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function token(privateKey: string, type: PrincipalType) {
  const iat = Math.floor(Date.now() / 1000);
  const id = `${type === "service" ? "svc" : "usr"}_${crypto.randomUUID().replaceAll("-", "")}`;
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: id,
    azp: "lifespace-platform-admin",
    principal_type: type,
    scope: "models:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function runtime(publicKey: string) {
  return {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    AI_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  };
}

async function request(path: string, bearer: string, publicKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://core.test${path}`, { ...init, headers }, runtime(publicKey));
}

describe("AI Model Admin HTTP boundary", () => {
  it("requires a service principal even when a user token carries models:manage", async () => {
    const { privateKey, publicKey } = await keys();
    const user = await token(privateKey, "user");
    const service = await token(privateKey, "service");

    const denied = await request("/api/v1/model-admin/ai/proposals", user, publicKey);
    expect(denied.status).toBe(403);

    const allowed = await request("/api/v1/model-admin/ai/proposals", service, publicKey);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ data: [] });
  });

  it("never turns an unconfigured AI request into a direct model publication", async () => {
    const { privateKey, publicKey } = await keys();
    const service = await token(privateKey, "service");
    const before = await (env as unknown as TestEnv).DB.prepare(
      "SELECT count(*) AS count FROM model_definitions WHERE state='published'",
    ).first<{ count: number }>();

    const response = await request("/api/v1/model-admin/ai/proposals", service, publicKey, {
      method: "POST",
      body: JSON.stringify({ instruction: "Create a simple inventory model" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "AI_NOT_CONFIGURED" } });

    const after = await (env as unknown as TestEnv).DB.prepare(
      "SELECT count(*) AS count FROM model_definitions WHERE state='published'",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});
