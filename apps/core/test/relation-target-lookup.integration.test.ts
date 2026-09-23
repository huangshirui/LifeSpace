import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { relationDiscoveryMetadata } from "../src/relation-targets";

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

async function token(
  privateKey: string,
  principalType: "user" | "service",
  principalId: string,
  clientId: string,
  scopes: string[],
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
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
  const userId = `usr_${suffix}`;
  const serviceId = `svc_${suffix}`;
  const clientId = `app_relation_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  const ownerPersonId = `per_owner_${suffix}`;
  const alphaPersonId = `per_alpha_${suffix}`;
  const betaPersonId = `per_beta_${suffix}`;
  const deletedPersonId = `per_deleted_${suffix}`;

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Relation Lookup", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(ownerPersonId, spaceId, userId, "Zulu Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(alphaPersonId, spaceId, null, "Alpha Person", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(betaPersonId, spaceId, null, "Beta Person", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at,deleted_at)
      VALUES(?,?,?,?,?,?,?)`).bind(deletedPersonId, spaceId, null, "Deleted Person", now, now, now),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "task", "write", "service", "svc_test_admin"),
  ]);

  return {
    db,
    privateKey,
    publicKey,
    userId,
    serviceId,
    clientId,
    spaceId,
    now,
    alphaPersonId,
    betaPersonId,
    ownerPersonId,
  };
}

type LookupPayload = {
  data: {
    items: Array<Record<string, unknown> & { id: string; label: string }>;
    nextCursor: string | null;
  };
};

describe("Relation target lookup", () => {
  it("lists active Person targets with stable pagination and bounded search", async () => {
    const f = await fixture();
    const accessToken = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);

    const first = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds?limit=2`,
    );
    expect(first.status).toBe(200);
    const firstPayload = await first.json<LookupPayload>();
    expect(firstPayload.data.items).toEqual([
      { id: f.alphaPersonId, label: "Alpha Person" },
      { id: f.betaPersonId, label: "Beta Person" },
    ]);
    expect(firstPayload.data.nextCursor).toBeTypeOf("string");

    const second = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds?limit=2&cursor=${encodeURIComponent(firstPayload.data.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const secondPayload = await second.json<LookupPayload>();
    expect(secondPayload.data.items).toEqual([{ id: f.ownerPersonId, label: "Zulu Owner" }]);
    expect(secondPayload.data.nextCursor).toBeNull();

    const searched = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds?q=alpha`,
    );
    expect(searched.status).toBe(200);
    const searchedPayload = await searched.json<LookupPayload>();
    expect(searchedPayload.data.items).toEqual([{ id: f.alphaPersonId, label: "Alpha Person" }]);

    const mismatchedCursor = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds?q=beta&cursor=${encodeURIComponent(firstPayload.data.nextCursor!)}`,
    );
    expect(mismatchedCursor.status).toBe(400);
  });

  it("allows a model-granted service to resolve minimal Person references without Space membership data", async () => {
    const f = await fixture();
    const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId,
      f.spaceId,
      "service",
      f.serviceId,
      "model",
      "task",
      "read",
      f.userId,
      f.now,
      null,
    ).run();
    const accessToken = await token(f.privateKey, "service", f.serviceId, f.clientId, ["resources:read"]);

    const response = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds?q=beta`,
    );
    expect(response.status).toBe(200);
    const payload = await response.json<LookupPayload>();
    expect(payload.data.items).toEqual([{ id: f.betaPersonId, label: "Beta Person" }]);
    expect(Object.keys(payload.data.items[0]).sort()).toEqual(["id", "label"]);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
    const revoked = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/assigneePersonIds`,
    );
    expect(revoked.status).toBe(403);
  });

  it("rejects non-relation fields and advertises record lookup/resolution as generic reference projections", async () => {
    const f = await fixture();
    const accessToken = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const response = await request(
      f.publicKey,
      accessToken,
      `/api/v1/spaces/${f.spaceId}/_relation-targets/task/name`,
    );
    expect(response.status).toBe(400);

    expect(relationDiscoveryMetadata({ type: "record", targetModel: "task" })).toEqual({
      targetModel: "task",
      cardinality: "one",
      lookup: {
        supported: true,
        method: "GET",
        pathTemplate: "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}",
        searchParameter: "q",
        cursorParameter: "cursor",
        limitParameter: "limit",
      },
      resolution: {
        supported: true,
        method: "POST",
        pathTemplate: "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
        maxIds: 50,
      },
    });
  });

  it("exposes distinct generic Person lookup and held-ID resolution contracts through Runtime Discovery", async () => {
    const f = await fixture();
    const accessToken = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const response = await request(f.publicKey, accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { models: Array<{
      key: string;
      fields: Array<{ key: string; relation?: unknown }>;
    }> } }>();
    const task = payload.data.models.find((model) => model.key === "task");
    expect(task?.fields.find((field) => field.key === "assigneePersonIds")?.relation).toEqual({
      targetModel: "person",
      cardinality: "many",
      lookup: {
        supported: true,
        method: "GET",
        pathTemplate: "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}",
        searchParameter: "q",
        cursorParameter: "cursor",
        limitParameter: "limit",
      },
      resolution: {
        supported: true,
        method: "POST",
        pathTemplate: "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
        maxIds: 50,
      },
    });
  });
});
