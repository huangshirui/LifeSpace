import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

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

async function token(privateKey: string, subject: string, clientId: string, principalType: "user" | "service", scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: subject,
    azp: clientId,
    principal_type: principalType,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const ownerId = `usr_owner_${suffix}`;
  const otherId = `usr_other_${suffix}`;
  const serviceId = `svc_policy_${suffix}`;
  const clientId = `app_policy_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const ownerPersonId = `per_owner_${suffix}`;
  const otherPersonId = `per_other_${suffix}`;
  const modelKey = `owned_note_${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Policy Test", ownerId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_owner_${suffix}`, spaceId, ownerId, "owner", now, now),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_other_${suffix}`, spaceId, otherId, "editor", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(ownerPersonId, spaceId, ownerId, "Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(otherPersonId, spaceId, otherId, "Other", now, now),
    db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(`grt_${suffix}`, spaceId, "service", serviceId, "space", null, "write", ownerId, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_admin_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    display: { singular: "Owned Note", plural: "Owned Notes" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
      ownerPersonId: { type: "person", required: true, immutable: true },
    },
    query: { searchable: ["title"], filterable: ["ownerPersonId"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    policies: {
      create: {
        all: [
          { op: "neq", left: { $ref: "actor.personId" }, right: { value: null } },
          { op: "eq", left: { $ref: "input.ownerPersonId" }, right: { $ref: "actor.personId" } },
        ],
      },
      read: { op: "neq", left: { $ref: "actor.personId" }, right: { value: null } },
      update: { op: "eq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } },
      delete: { op: "eq", left: { $ref: "record.ownerPersonId" }, right: { $ref: "actor.personId" } },
    },
  }, "initial");

  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", publisher.id).run();

  const scopes = ["resources:read", "resources:write"];
  return {
    db,
    publicKey,
    privateKey,
    spaceId,
    modelKey,
    clientId,
    ownerPersonId,
    otherPersonId,
    ownerToken: await token(privateKey, ownerId, clientId, "user", scopes),
    otherToken: await token(privateKey, otherId, clientId, "user", scopes),
    serviceToken: await token(privateKey, serviceId, clientId, "service", scopes),
  };
}

describe("Generic Policy Engine", () => {
  it("prevents owner spoofing and enforces record ownership inside the same writable Space", async () => {
    const f = await fixture();

    const spoof = await request(f.publicKey, f.otherToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records`, {
      method: "POST",
      body: JSON.stringify({ title: "Spoof", ownerPersonId: f.ownerPersonId }),
    });
    expect(spoof.status).toBe(403);

    const createdResponse = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records`, {
      method: "POST",
      body: JSON.stringify({ title: "Owner note", ownerPersonId: f.ownerPersonId }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ data: { id: string; version: number } }>();

    const otherRead = await request(f.publicKey, f.otherToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records/${created.data.id}`);
    expect(otherRead.status).toBe(200);

    const otherUpdate = await request(f.publicKey, f.otherToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "Hijacked" }),
    });
    expect(otherUpdate.status).toBe(403);

    const ownerUpdate = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "Updated by owner" }),
    });
    expect(ownerUpdate.status).toBe(200);
  });

  it("denies service principals when a model requires an active actor Space Person even if Data Grant allows write", async () => {
    const f = await fixture();
    const response = await request(f.publicKey, f.serviceToken, `/api/v1/spaces/${f.spaceId}/models/${f.modelKey}/records`);
    expect(response.status).toBe(403);
  });
});
