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
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function token(privateKey: string, type: PrincipalType, clientId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: `${type}_${crypto.randomUUID().replaceAll("-", "")}`,
    azp: clientId,
    principal_type: type,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function call(
  publicKey: string,
  executorToken: string,
  path: string,
  actorToken?: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${executorToken}`);
  if (actorToken) headers.set("x-lifespace-actor-token", actorToken);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

describe("Platform Admin API", () => {
  it("requires a service executor plus a same-application platform-admin user proof", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const target = `app_target_${crypto.randomUUID().replaceAll("-", "")}`;
    const service = await token(pair.privateKey, "service", clientId, ["applications:manage"]);

    const missingActor = await call(pair.publicKey, service, `/api/v1/platform-admin/applications/${target}/model-access`);
    expect(missingActor.status).toBe(401);

    const ordinaryActor = await token(pair.privateKey, "user", clientId, ["profile:read"]);
    const ordinaryResponse = await call(pair.publicKey, service, `/api/v1/platform-admin/applications/${target}/model-access`, ordinaryActor);
    expect(ordinaryResponse.status).toBe(403);

    const wrongApplicationActor = await token(pair.privateKey, "user", "app_other_console", ["platform:admin"]);
    const mismatchResponse = await call(pair.publicKey, service, `/api/v1/platform-admin/applications/${target}/model-access`, wrongApplicationActor);
    expect(mismatchResponse.status).toBe(403);

    const userExecutor = await token(pair.privateKey, "user", clientId, ["applications:manage", "platform:admin"]);
    const userActor = await token(pair.privateKey, "user", clientId, ["platform:admin"]);
    const userExecutorResponse = await call(pair.publicKey, userExecutor, `/api/v1/platform-admin/applications/${target}/model-access`, userActor);
    expect(userExecutorResponse.status).toBe(403);
  });

  it("replaces application model access and writes non-secret actor/executor audit evidence", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const target = `app_target_${crypto.randomUUID().replaceAll("-", "")}`;
    const service = await token(pair.privateKey, "service", clientId, ["applications:manage", "audit:read"]);
    const actor = await token(pair.privateKey, "user", clientId, ["platform:admin"]);

    const replace = await call(
      pair.publicKey,
      service,
      `/api/v1/platform-admin/applications/${target}/model-access`,
      actor,
      { method: "PUT", body: JSON.stringify({ models: [] }) },
    );
    expect(replace.status).toBe(200);
    expect(await replace.json()).toMatchObject({ data: { applicationId: target, models: [] } });

    const list = await call(pair.publicKey, service, `/api/v1/platform-admin/applications/${target}/model-access`, actor);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ data: { applicationId: target, models: [] } });

    const audit = await call(pair.publicKey, service, "/api/v1/platform-admin/audit?limit=20", actor);
    expect(audit.status).toBe(200);
    const payload = await audit.json<{ data: Array<{ operation: string; targetId: string; actorUserId: string; executorPrincipalId: string }> }>();
    const entry = payload.data.find((candidate) => candidate.operation === "application_model_access.replace" && candidate.targetId === target);
    expect(entry?.actorUserId).toMatch(/^user_/u);
    expect(entry?.executorPrincipalId).toMatch(/^service_/u);
  });
});
