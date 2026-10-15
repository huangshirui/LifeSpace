import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition, retireModel } from "../src/model-registry";

const pem = (label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer) => {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
};

async function keyPair() {
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

async function token(privateKey: string, userId: string, clientId: string, actorId?: string) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: actorId ?? userId,
    azp: clientId,
    principal_type: "user",
    scope: "spaces:manage",
    iat: now,
    exp: now + 900,
    jti: `tok_external_definition_${crypto.randomUUID().replaceAll("-", "")}`,
    ...(actorId ? { actor_type: "agent", actor_id: actorId, principal_id: userId, purpose: "agent_execution" } : {}),
  }, privateKey, "RS256");
}

async function request(publicKey: string, bearer: string, path: string, method = "GET", body?: unknown) {
  return createApp().request(`https://example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {
    DB: (env as unknown as { DB: D1Database }).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

describe("Space bindable External Model Definition discovery", () => {
  it("uses direct Space-management authority, hides Native models and enforces the definition access ceiling before binding", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const { privateKey, publicKey } = await keyPair();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const owner = `usr_external_definition_${suffix}`;
    const outsider = `usr_external_definition_other_${suffix}`;
    const appId = `app_external_definition_${suffix}`;
    const space = `spc_${suffix}`;
    const externalKey = `external_definition_${suffix.slice(0, 8)}`;
    const readOnlyKey = `external_readonly_${suffix.slice(0, 8)}`;
    const timestamp = new Date().toISOString();

    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(space, "External Definition Test", owner, timestamp, timestamp, "UTC"),
      db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind(`mem_${suffix}`, space, owner, "owner", timestamp, timestamp),
    ]);

    const publisher: Principal = {
      type: "service",
      id: `svc_external_definition_${suffix}`,
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: `tok_external_definition_admin_${suffix}`,
    };
    await publishModelDefinition({ DB: db } as Bindings, publisher, {
      definitionVersion: 1,
      origin: "external",
      key: externalKey,
      description: "Provider-backed documents for Space binding.",
      display: { singular: "External Document", plural: "External Documents" },
      fields: {},
      access: ["read", "write"],
    }, "initial");
    await publishModelDefinition({ DB: db } as Bindings, publisher, {
      definitionVersion: 1,
      origin: "external",
      key: readOnlyKey,
      description: "Provider-backed read-only documents.",
      display: { singular: "Read-only External Document", plural: "Read-only External Documents" },
      fields: {},
      access: ["read"],
    }, "initial");

    const ownerBearer = await token(privateKey, owner, appId);
    const ownerResponse = await request(publicKey, ownerBearer, `/api/v1/spaces/${space}/external-model-definitions`);
    expect(ownerResponse.status, JSON.stringify(await ownerResponse.clone().json())).toBe(200);
    const items = (await ownerResponse.json<any>()).data.items as Array<{ key: string; displayName: string; access: string[] }>;
    expect(items).toContainEqual(expect.objectContaining({ key: externalKey, displayName: "External Document", access: ["read", "write"] }));
    expect(items).toContainEqual(expect.objectContaining({ key: readOnlyKey, access: ["read"] }));
    expect(items.some((item) => item.key === "task")).toBe(false);

    const excessiveWrite = await request(publicKey, ownerBearer, `/api/v1/spaces/${space}/external-models`, "POST", {
      definitionKey: readOnlyKey,
      connectionId: `exs_${"a".repeat(32)}`,
      resourceId: "synthetic-provider-resource",
      declaredAccess: "write",
    });
    expect(excessiveWrite.status).toBe(422);
    expect((await excessiveWrite.json<any>()).error.code).toBe("EXTERNAL_VALIDATION_FAILED");

    const sourceId = `exs_${crypto.randomUUID().replaceAll("-", "")}`;
    const registrationId = `ext_${crypto.randomUUID().replaceAll("-", "")}`;
    const snapshot = {
      resourceId: `synthetic-retired-resource-${suffix}`,
      displayName: "Retired definition binding",
      fields: [],
      capabilities: {
        get: true,
        query: true,
        create: true,
        update: true,
        delete: true,
        batchWrite: true,
        atomicBatch: false,
        transaction: false,
        versionedWrite: false,
        actions: false,
        relationTargetResolution: false,
      },
      queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
      adapterState: {},
    };
    await db.batch([
      db.prepare("INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,display_name,access_mode,created_by_user_id,created_at,updated_at) VALUES(?,?,?,'cnx_test','active','Retired definition connection','write',?,?,?)")
        .bind(sourceId, space, "notion", owner, timestamp, timestamp),
      db.prepare("INSERT INTO external_models(model_key,space_id,source_id,provider_key,resource_id,display_name,declared_access,snapshot_json,schema_hash,schema_observed_at,status,last_successful_refresh_at,next_refresh_at,created_at,updated_at,definition_key) VALUES(?,?,?,?,?,?,?,?,'synthetic-schema',?,'active',?,NULL,?,?,?)")
        .bind(registrationId, space, sourceId, "notion", snapshot.resourceId, snapshot.displayName, "read", JSON.stringify(snapshot), timestamp, timestamp, timestamp, timestamp, readOnlyKey),
    ]);
    await retireModel({ DB: db } as Bindings, publisher, readOnlyKey);
    const retiredWriteElevation = await request(
      publicKey,
      ownerBearer,
      `/api/v1/spaces/${space}/external-models/${readOnlyKey}`,
      "PATCH",
      { declaredAccess: "write" },
    );
    expect(retiredWriteElevation.status).toBe(422);
    expect((await retiredWriteElevation.json<any>()).error.code).toBe("EXTERNAL_VALIDATION_FAILED");

    const outsiderResponse = await request(publicKey, await token(privateKey, outsider, appId), `/api/v1/spaces/${space}/external-model-definitions`);
    expect(outsiderResponse.status).toBe(403);

    const delegatedResponse = await request(
      publicKey,
      await token(privateKey, owner, appId, `agt_${crypto.randomUUID().replaceAll("-", "")}`),
      `/api/v1/spaces/${space}/external-model-definitions`,
    );
    expect(delegatedResponse.status).toBe(403);
  });
});
