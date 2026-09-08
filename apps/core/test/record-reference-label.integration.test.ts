import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type ResourcePayload = { data: { id: string; version: number } };
type LookupPayload = { data: { items: Array<{ id: string; label: string }>; nextCursor: string | null } };
type ResolutionPayload = {
  data: {
    items: Array<
      | { id: string; status: "resolved"; label: string }
      | { id: string; status: "unavailable" }
    >;
  };
};

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

async function token(privateKey: string, userId: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(
  publicKey: string,
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return createApp().request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const userId = `usr_record_ref_${suffix}`;
  const clientId = `app_record_ref_${suffix}`;
  const spaceId = `spc_record_ref_${suffix}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Record Reference Labels", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_record_ref_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_record_ref_${suffix}`, spaceId, userId, "Reference Label Tester", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_record_ref_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_record_ref_admin_${suffix}`,
  };
  return {
    db,
    privateKey,
    publicKey,
    suffix,
    userId,
    clientId,
    spaceId,
    publisher,
    accessToken: await token(privateKey, userId, clientId),
  };
}

async function grantAppModel(db: D1Database, clientId: string, modelKey: string, maxAccess: "read" | "write") {
  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, maxAccess, "service", "svc_record_ref_test").run();
}

async function publishPair(
  f: Awaited<ReturnType<typeof fixture>>,
  referenceLabel?: { field: string } | { template: string },
) {
  const targetKey = `ref_target_${f.suffix}`;
  const sourceKey = `ref_source_${f.suffix}`;

  await publishModelDefinition({ DB: f.db } as Bindings, f.publisher, {
    definitionVersion: 1,
    key: targetKey,
    display: { singular: "Reference Target", plural: "Reference Targets" },
    fields: {
      name: { type: "string", required: true, minLength: 1, maxLength: 80 },
      date: { type: "date", nullable: true },
    },
    ...(referenceLabel ? { referenceLabel } : {}),
    query: { searchable: ["name"], sortable: ["name"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");

  await publishModelDefinition({ DB: f.db } as Bindings, f.publisher, {
    definitionVersion: 1,
    key: sourceKey,
    display: { singular: "Reference Source", plural: "Reference Sources" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 80 },
      targetRecordId: { type: "record", targetModel: targetKey, nullable: true },
      targetRecordIds: { type: "record_list", targetModel: targetKey },
    },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");

  await grantAppModel(f.db, f.clientId, targetKey, "write");
  await grantAppModel(f.db, f.clientId, sourceKey, "read");
  return { targetKey, sourceKey };
}

async function createTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  targetKey: string,
  body: { name: string; date?: string | null },
) {
  const response = await request(
    f.publicKey,
    f.accessToken,
    `/api/v1/spaces/${f.spaceId}/models/${targetKey}/records`,
    "POST",
    body,
  );
  expect(response.status).toBe(201);
  return response.json<ResourcePayload>();
}

describe("ordinary-record reference projection", () => {
  it("uses one model-owned template for lookup, search, pagination and batch resolution", async () => {
    const f = await fixture();
    const { targetKey, sourceKey } = await publishPair(f, { template: "{name} · {date}" });

    const alpha = await createTarget(f, targetKey, { name: "Alpha", date: "2026-09-07" });
    const beta = await createTarget(f, targetKey, { name: "Beta", date: "2026-09-08" });
    const gamma = await createTarget(f, targetKey, { name: "Gamma", date: "2026-09-09" });

    const first = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/${sourceKey}/targetRecordId?limit=2`,
    );
    expect(first.status).toBe(200);
    const firstPayload = await first.json<LookupPayload>();
    expect(firstPayload.data.items).toEqual([
      { id: alpha.data.id, label: "Alpha · 2026-09-07" },
      { id: beta.data.id, label: "Beta · 2026-09-08" },
    ]);
    expect(firstPayload.data.nextCursor).toBeTypeOf("string");

    const second = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/${sourceKey}/targetRecordId?limit=2&cursor=${encodeURIComponent(firstPayload.data.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    expect(await second.json<LookupPayload>()).toMatchObject({
      data: { items: [{ id: gamma.data.id, label: "Gamma · 2026-09-09" }], nextCursor: null },
    });

    const searched = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/${sourceKey}/targetRecordId?q=beta`,
    );
    expect(searched.status).toBe(200);
    expect((await searched.json<LookupPayload>()).data.items).toEqual([
      { id: beta.data.id, label: "Beta · 2026-09-08" },
    ]);

    const missingId = `rec_missing_${f.suffix}`;
    const resolved = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_reference-resolutions/${sourceKey}/targetRecordIds`,
      "POST",
      { ids: [beta.data.id, missingId, beta.data.id] },
    );
    expect(resolved.status).toBe(200);
    expect((await resolved.json<ResolutionPayload>()).data.items).toEqual([
      { id: beta.data.id, status: "resolved", label: "Beta · 2026-09-08" },
      { id: missingId, status: "unavailable" },
      { id: beta.data.id, status: "resolved", label: "Beta · 2026-09-08" },
    ]);

    const deleted = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/models/${targetKey}/records/${beta.data.id}`,
      "DELETE",
      { version: beta.data.version },
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_reference-resolutions/${sourceKey}/targetRecordId`,
      "POST",
      { ids: [beta.data.id] },
    );
    expect(afterDelete.status).toBe(200);
    expect((await afterDelete.json<ResolutionPayload>()).data.items).toEqual([
      { id: beta.data.id, status: "unavailable" },
    ]);

    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?")
      .bind(f.clientId, targetKey).run();
    const denied = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/${sourceKey}/targetRecordId`,
    );
    expect(denied.status).toBe(403);
  });

  it("uses the stable record ID when the target model does not declare an explicit referenceLabel", async () => {
    const f = await fixture();
    const { targetKey, sourceKey } = await publishPair(f);
    const target = await createTarget(f, targetKey, { name: "No Heuristic Guess" });

    const lookup = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/${sourceKey}/targetRecordId`,
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json<LookupPayload>()).data.items).toEqual([
      { id: target.data.id, label: target.data.id },
    ]);

    const resolution = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_reference-resolutions/${sourceKey}/targetRecordId`,
      "POST",
      { ids: [target.data.id] },
    );
    expect(resolution.status).toBe(200);
    expect((await resolution.json<ResolutionPayload>()).data.items).toEqual([
      { id: target.data.id, status: "resolved", label: target.data.id },
    ]);
  });
});
