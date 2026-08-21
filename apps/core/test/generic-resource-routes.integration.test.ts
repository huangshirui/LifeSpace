import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

type AuditActor = {
  type: "user" | "service" | "device";
  id: string;
  displayName: string;
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

async function token(privateKey: string, userId: string, clientId: string, scopes: string[]) {
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
  const userId = `usr_${suffix}`;
  const clientId = `app_generic_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const personId = `per_${suffix}`;
  const route = `notes-${suffix.slice(0, 10)}`;
  const modelKey = `note_${suffix.slice(0, 10)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Generic HTTP Test", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "Generic Tester", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    route,
    display: { singular: "Note", plural: "Notes" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 120 },
      pinned: { type: "boolean" },
    },
    query: { searchable: ["title"], filterable: ["pinned"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");

  const accessToken = await token(privateKey, userId, clientId, ["resources:read", "resources:write"]);
  return { db, privateKey, publicKey, userId, clientId, spaceId, route, modelKey, accessToken };
}

describe("Generic Resource HTTP routes", () => {
  it("denies a published model until the application is in the model access catalog", async () => {
    const f = await fixture();
    const response = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}`);
    expect(response.status).toBe(403);
  });

  it("creates, reads, updates, lists and deletes a runtime-published model without a handwritten router", async () => {
    const f = await fixture();
    await f.db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(f.clientId, f.modelKey, "write", "service", "svc_test_admin").run();

    const createdResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}`, {
      method: "POST",
      body: JSON.stringify({ title: "Runtime note", pinned: false }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ data: {
      id: string;
      modelKey: string;
      title: string;
      pinned: boolean;
      version: number;
      createdBy: AuditActor;
      updatedBy: AuditActor;
    } }>();
    expect(created.data).toMatchObject({ modelKey: f.modelKey, title: "Runtime note", pinned: false, version: 1 });
    expect(created.data.createdBy).toEqual({ type: "user", id: f.userId, displayName: "Generic Tester" });
    expect(created.data.updatedBy).toEqual({ type: "user", id: f.userId, displayName: "Generic Tester" });

    const storedAfterCreate = await f.db.prepare(`SELECT created_by_name_snapshot,updated_by_name_snapshot
      FROM resource_records WHERE id=?`).bind(created.data.id).first<{
        created_by_name_snapshot: string;
        updated_by_name_snapshot: string;
      }>();
    expect(storedAfterCreate).toMatchObject({
      created_by_name_snapshot: "Generic Tester",
      updated_by_name_snapshot: "Generic Tester",
    });

    const itemResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}/${created.data.id}`);
    expect(itemResponse.status).toBe(200);
    const item = await itemResponse.json<{ data: { createdBy: AuditActor; updatedBy: AuditActor } }>();
    expect(item.data.createdBy.displayName).toBe("Generic Tester");

    await f.db.prepare(`UPDATE space_people SET display_name=?,updated_at=?
      WHERE space_id=? AND linked_user_id=?`).bind("Renamed Tester", new Date().toISOString(), f.spaceId, f.userId).run();

    const updatedResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "Updated note", pinned: true }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json<{ data: {
      title: string;
      pinned: boolean;
      version: number;
      createdBy: AuditActor;
      updatedBy: AuditActor;
    } }>();
    expect(updated.data).toMatchObject({ title: "Updated note", pinned: true, version: 2 });
    expect(updated.data.createdBy.displayName).toBe("Generic Tester");
    expect(updated.data.updatedBy).toEqual({ type: "user", id: f.userId, displayName: "Renamed Tester" });

    const listResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}`);
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{ data: { items: Array<{
      id: string;
      createdBy: AuditActor;
      updatedBy: AuditActor;
    }> } }>();
    const listed = list.data.items.find((entry) => entry.id === created.data.id);
    expect(listed).toBeTruthy();
    expect(listed?.createdBy.displayName).toBe("Generic Tester");
    expect(listed?.updatedBy.displayName).toBe("Renamed Tester");

    const deletedResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}/${created.data.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: 2 }),
    });
    expect(deletedResponse.status).toBe(204);

    const missingResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/${f.route}/${created.data.id}`);
    expect(missingResponse.status).toBe(404);
  });

  it("requires the stable resources scope even when application/model access exists", async () => {
    const f = await fixture();
    await f.db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(f.clientId, f.modelKey, "write", "service", "svc_test_admin").run();
    const scopeLessToken = await token(f.privateKey, f.userId, f.clientId, ["spaces:read"]);
    const response = await request(f.publicKey, scopeLessToken, `/api/v1/spaces/${f.spaceId}/${f.route}`);
    expect(response.status).toBe(403);
  });
});
