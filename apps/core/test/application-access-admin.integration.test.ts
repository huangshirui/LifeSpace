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

describe("Application model-access internal admin API", () => {
  it("replaces one application's model catalog and rejects user principals", async () => {
    const pair = await keys();
    const serviceToken = await token(pair.privateKey, "service", ["models:manage"]);
    const userToken = await token(pair.privateKey, "user", ["models:manage"]);
    const applicationId = `app_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const path = `/internal/v1/application-model-access/${applicationId}`;

    const modelsResponse = await call(pair.publicKey, serviceToken, "/api/v1/model-admin/models");
    expect(modelsResponse.status).toBe(200);
    const models = await modelsResponse.json<{ data: Array<{ key: string; definition: { access: string[] } }> }>();
    const writable = models.data.find((model) => model.definition.access.includes("write"));
    expect(writable).toBeDefined();

    const denied = await call(
      pair.publicKey,
      userToken,
      path,
      { method: "PUT", body: JSON.stringify({ models: [{ modelKey: writable!.key, maxAccess: "write" }] }) },
    );
    expect(denied.status).toBe(403);

    const replace = await call(
      pair.publicKey,
      serviceToken,
      path,
      { method: "PUT", body: JSON.stringify({ models: [{ modelKey: writable!.key, maxAccess: "write" }] }) },
    );
    expect(replace.status).toBe(200);
    const replaced = await replace.json<{ data: { applicationId: string; models: Array<{ modelKey: string; maxAccess: string }> } }>();
    expect(replaced.data).toEqual({ applicationId, models: [{ modelKey: writable!.key, maxAccess: "write" }] });

    const stored = await (env as unknown as TestEnv).DB.prepare(
      "SELECT application_id applicationId,model_key modelKey,max_access maxAccess,created_by_type createdByType FROM application_model_access WHERE application_id=?",
    ).bind(applicationId).all<{ applicationId: string; modelKey: string; maxAccess: string; createdByType: string }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]).toMatchObject({ applicationId, modelKey: writable!.key, maxAccess: "write", createdByType: "service" });

    const get = await call(pair.publicKey, serviceToken, path);
    expect(get.status).toBe(200);
    const current = await get.json<{ data: { applicationId: string; models: Array<{ modelKey: string; maxAccess: string }> } }>();
    expect(current.data.applicationId).toBe(applicationId);
    expect(current.data.models).toHaveLength(1);

    const clear = await call(
      pair.publicKey,
      serviceToken,
      path,
      { method: "PUT", body: JSON.stringify({ models: [] }) },
    );
    expect(clear.status).toBe(200);
    const afterClear = await (env as unknown as TestEnv).DB.prepare(
      "SELECT model_key FROM application_model_access WHERE application_id=?",
    ).bind(applicationId).all();
    expect(afterClear.results).toHaveLength(0);
  });

  it("rejects unknown and duplicate model access entries", async () => {
    const pair = await keys();
    const serviceToken = await token(pair.privateKey, "service", ["models:manage"]);
    const applicationId = `app_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const path = `/internal/v1/application-model-access/${applicationId}`;

    const unknown = await call(
      pair.publicKey,
      serviceToken,
      path,
      { method: "PUT", body: JSON.stringify({ models: [{ modelKey: "does_not_exist", maxAccess: "read" }] }) },
    );
    expect(unknown.status).toBe(404);

    const duplicate = await call(
      pair.publicKey,
      serviceToken,
      path,
      {
        method: "PUT",
        body: JSON.stringify({
          models: [
            { modelKey: "task", maxAccess: "read" },
            { modelKey: "task", maxAccess: "write" },
          ],
        }),
      },
    );
    expect(duplicate.status).toBe(422);
  });
});