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

async function serviceToken(privateKey: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: `svc_${crypto.randomUUID().replaceAll("-", "")}`,
    azp: clientId,
    principal_type: "service",
    scope: "models:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function actorProof(privateKey: string, clientId: string, purpose = "platform_admin_actor") {
  const iat = Math.floor(Date.now() / 1000);
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await sign({
    iss: "lifespace-identity",
    aud: ["lifespace-core", "lifespace-identity"],
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "platform:admin",
    purpose,
    iat,
    exp: iat + 300,
    jti: `pad_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
  return { token, userId };
}

async function call(
  publicKey: string,
  executorToken: string,
  path: string,
  actorToken: string | null,
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

function definition() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return {
    definitionVersion: 1,
    key: `console_audit_${suffix}`,
    route: `console-audits-${suffix}`,
    display: { singular: "Console Audit", plural: "Console Audits" },
    fields: { name: { type: "string", required: true, maxLength: 100 } },
    query: { searchable: ["name"], sortable: ["name"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

describe("Console-aware Model Admin audit", () => {
  it("keeps service automation compatible when no human actor proof is supplied", async () => {
    const pair = await keys();
    const clientId = `app_automation_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await serviceToken(pair.privateKey, clientId);
    const model = definition();
    const response = await call(pair.publicKey, executor, "/api/v1/model-admin/models", null, {
      method: "POST",
      body: JSON.stringify({ definition: model, compatibility: "initial" }),
    });
    expect(response.status).toBe(201);
    const rows = await (env as unknown as TestEnv).DB.prepare("SELECT COUNT(*) count FROM platform_admin_audit WHERE target_id=?")
      .bind(model.key).first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("requires a valid purpose-bound proof when a Console actor header is present and records publish/retire", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await serviceToken(pair.privateKey, clientId);
    const invalidActor = await actorProof(pair.privateKey, clientId, "ordinary_user_token");
    const invalidModel = definition();
    const denied = await call(pair.publicKey, executor, "/api/v1/model-admin/models", invalidActor.token, {
      method: "POST",
      body: JSON.stringify({ definition: invalidModel, compatibility: "initial" }),
    });
    expect(denied.status).toBe(401);
    expect(await (env as unknown as TestEnv).DB.prepare("SELECT id FROM model_definitions WHERE model_key=? AND state='published'")
      .bind(invalidModel.key).first()).toBeNull();

    const actor = await actorProof(pair.privateKey, clientId);
    const model = definition();
    const published = await call(pair.publicKey, executor, "/api/v1/model-admin/models", actor.token, {
      method: "POST",
      body: JSON.stringify({ definition: model, compatibility: "initial" }),
    });
    expect(published.status).toBe(201);

    const publishAudit = await (env as unknown as TestEnv).DB.prepare(`SELECT actor_user_id actorUserId,operation,target_id targetId,result,summary_json summaryJson
      FROM platform_admin_audit WHERE operation='model.publish' AND target_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(model.key).first<{ actorUserId: string; operation: string; targetId: string; result: string; summaryJson: string }>();
    expect(publishAudit).toMatchObject({ actorUserId: actor.userId, operation: "model.publish", targetId: model.key, result: "success" });
    expect(JSON.parse(publishAudit!.summaryJson)).toMatchObject({ modelKey: model.key, version: 1, compatibility: "initial" });

    const retired = await call(pair.publicKey, executor, `/api/v1/model-admin/models/${model.key}/retire`, actor.token, { method: "POST" });
    expect(retired.status).toBe(204);
    const retireAudit = await (env as unknown as TestEnv).DB.prepare(`SELECT actor_user_id actorUserId,result
      FROM platform_admin_audit WHERE operation='model.retire' AND target_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(model.key).first<{ actorUserId: string; result: string }>();
    expect(retireAudit).toEqual({ actorUserId: actor.userId, result: "success" });
  });

  it("retains failed Console mutation evidence", async () => {
    const pair = await keys();
    const clientId = `app_console_${crypto.randomUUID().replaceAll("-", "")}`;
    const executor = await serviceToken(pair.privateKey, clientId);
    const actor = await actorProof(pair.privateKey, clientId);
    const missingKey = `missing_${crypto.randomUUID().replaceAll("-", "")}`;
    const response = await call(pair.publicKey, executor, `/api/v1/model-admin/models/${missingKey}/retire`, actor.token, { method: "POST" });
    expect(response.status).toBe(404);
    const audit = await (env as unknown as TestEnv).DB.prepare(`SELECT result,summary_json summaryJson FROM platform_admin_audit
      WHERE operation='model.retire' AND target_id=? ORDER BY created_at DESC LIMIT 1`).bind(missingKey)
      .first<{ result: string; summaryJson: string }>();
    expect(audit?.result).toBe("failure");
    expect(JSON.parse(audit!.summaryJson)).toMatchObject({ modelKey: missingKey, errorCode: "MODEL_NOT_FOUND" });
  });
});
