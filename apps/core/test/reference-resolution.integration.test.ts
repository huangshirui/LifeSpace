import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Item =
  | { id: string; status: "resolved"; label: string }
  | { id: string; status: "unavailable" };

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

async function token(privateKey: string, userId: string, clientId: string, scopes = ["resources:read", "resources:write"]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(
  publicKey: string,
  accessToken: string,
  path: string,
  method = "POST",
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
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_ref_${suffix}`;
  const clientId = `app_ref_${suffix}`;
  const hiddenClientId = `app_ref_hidden_${suffix}`;
  const spaceId = `spc_ref_${suffix}`;
  const otherSpaceId = `spc_ref_other_${suffix}`;
  const ownerPersonId = `per_ref_owner_${suffix}`;
  const alphaPersonId = `per_ref_alpha_${suffix}`;
  const betaPersonId = `per_ref_beta_${suffix}`;
  const deletedPersonId = `per_ref_deleted_${suffix}`;
  const otherPersonId = `per_ref_other_${suffix}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Reference Resolution", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(otherSpaceId, "Other Reference Space", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_ref_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(ownerPersonId, spaceId, userId, "Reference Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(alphaPersonId, spaceId, null, "Alpha Reference", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(betaPersonId, spaceId, null, "Beta Reference", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at,deleted_at)
      VALUES(?,?,?,?,?,?,?)`).bind(deletedPersonId, spaceId, null, "Deleted Reference", now, now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(otherPersonId, otherSpaceId, null, "Other Reference", now, now),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "task", "write", "service", "svc_test_admin"),
  ]);

  const accessToken = await token(privateKey, userId, clientId);
  const hiddenToken = await token(privateKey, userId, hiddenClientId, ["resources:read"]);
  return {
    db, privateKey, publicKey, userId, clientId, hiddenClientId, spaceId, otherSpaceId,
    ownerPersonId, alphaPersonId, betaPersonId, deletedPersonId, otherPersonId, now, accessToken, hiddenToken,
  };
}

async function resolve(
  f: Awaited<ReturnType<typeof fixture>>,
  ids: string[],
  accessToken = f.accessToken,
  modelKey = "task",
  fieldKey = "assigneePersonIds",
) {
  return request(
    f.publicKey,
    accessToken,
    `/api/v1/spaces/${f.spaceId}/_reference-resolutions/${modelKey}/${fieldKey}`,
    "POST",
    { ids },
  );
}

async function items(response: Response): Promise<Item[]> {
  return (await response.json<{ data: { items: Item[] } }>()).data.items;
}

describe("Batch Reference Resolution", () => {
  it("resolves Person IDs in input order while collapsing hidden existence distinctions to unavailable", async () => {
    const f = await fixture();
    const missingId = `per_ref_missing_${crypto.randomUUID().replaceAll("-", "")}`;
    const response = await resolve(f, [
      f.alphaPersonId,
      missingId,
      f.deletedPersonId,
      f.otherPersonId,
      f.alphaPersonId,
    ]);
    expect(response.status).toBe(200);
    expect(await items(response)).toEqual([
      { id: f.alphaPersonId, status: "resolved", label: "Alpha Reference" },
      { id: missingId, status: "unavailable" },
      { id: f.deletedPersonId, status: "unavailable" },
      { id: f.otherPersonId, status: "unavailable" },
      { id: f.alphaPersonId, status: "resolved", label: "Alpha Reference" },
    ]);
  });

  it("reflects current label/removal state and does not turn a resolved label into mutation authority", async () => {
    const f = await fixture();
    const before = await resolve(f, [f.alphaPersonId]);
    expect(before.status).toBe(200);
    expect(await items(before)).toEqual([{ id: f.alphaPersonId, status: "resolved", label: "Alpha Reference" }]);

    await f.db.prepare("UPDATE space_people SET display_name=?,updated_at=? WHERE id=?")
      .bind("Alpha Renamed", new Date().toISOString(), f.alphaPersonId).run();
    const renamed = await resolve(f, [f.alphaPersonId]);
    expect(await items(renamed)).toEqual([{ id: f.alphaPersonId, status: "resolved", label: "Alpha Renamed" }]);

    await f.db.prepare("UPDATE space_people SET deleted_at=?,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), new Date().toISOString(), f.alphaPersonId).run();
    const removed = await resolve(f, [f.alphaPersonId]);
    expect(await items(removed)).toEqual([{ id: f.alphaPersonId, status: "unavailable" }]);

    const mutation = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/models/task/records`, "POST", {
      name: "Must recheck relation integrity",
      assigneePersonIds: [f.alphaPersonId],
    });
    expect(mutation.status).toBeGreaterThanOrEqual(400);
    expect(mutation.status).toBeLessThan(500);
  });

  it("denies the whole operation when current source relation projection authority is absent", async () => {
    const f = await fixture();
    const response = await resolve(f, [f.alphaPersonId], f.hiddenToken);
    expect(response.status).toBe(403);
    const payload = await response.json<{ error: { code: string } }>();
    expect(payload.error.code).toBe("FORBIDDEN");
  });

  it("uses the target record ID as the canonical fallback when no explicit record referenceLabel is declared", async () => {
    const f = await fixture();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const modelKey = `ref_link_${suffix}`;
    const publisher: Principal = {
      type: "service",
      id: `svc_ref_publisher_${suffix}`,
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: `tok_ref_admin_${suffix}`,
    };
    await publishModelDefinition({ DB: f.db } as Bindings, publisher, {
      definitionVersion: 1,
      key: modelKey,
      display: { singular: "Reference Link", plural: "Reference Links" },
      fields: {
        title: { type: "string", required: true, minLength: 1, maxLength: 80 },
        targetRecordId: { type: "record", targetModel: "task" },
      },
      access: ["read", "write"],
      lifecycle: { optimisticConcurrency: true, softDelete: true },
    }, "initial");
    await f.db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(f.clientId, modelKey, "read", "service", "svc_test_admin").run();

    const created = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/models/task/records`, "POST", {
      name: "Canonical fallback task",
    });
    expect(created.status).toBe(201);
    const task = await created.json<{ data: { id: string } }>();

    const response = await request(
      f.publicKey,
      f.accessToken,
      `/api/v1/spaces/${f.spaceId}/_reference-resolutions/${modelKey}/targetRecordId`,
      "POST",
      { ids: [task.data.id, task.data.id] },
    );
    expect(response.status).toBe(200);
    expect(await items(response)).toEqual([
      { id: task.data.id, status: "resolved", label: task.data.id },
      { id: task.data.id, status: "resolved", label: task.data.id },
    ]);
  });

  it("enforces the closed 1-50 Person-ID request shape", async () => {
    const f = await fixture();
    const path = `/api/v1/spaces/${f.spaceId}/_reference-resolutions/task/assigneePersonIds`;
    const cases: unknown[] = [
      {},
      { ids: [] },
      { ids: Array.from({ length: 51 }, (_, index) => `per_ref_bound_${index}`) },
      { ids: ["rec_wrong_kind"] },
      { ids: [f.alphaPersonId], extra: true },
    ];
    for (const body of cases) {
      const response = await request(f.publicKey, f.accessToken, path, "POST", body);
      expect(response.status).toBe(400);
    }
  });
});
