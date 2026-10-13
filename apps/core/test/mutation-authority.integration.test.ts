import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { getOrCreateActiveModelContract } from "../src/model-contract-service";
import type { Bindings } from "../src/env";

type TestEnv = { DB: D1Database };

type ErrorPayload = { error: { code: string; message: string } };

type ResourcePayload = {
  data: {
    id: string;
    version: number;
    status: string;
    completedAt?: string | null;
    completedByType?: string | null;
    completedById?: string | null;
    fulfilledAt?: string | null;
    name?: string;
    title?: string;
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

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
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
  const personId = `per_${suffix}`;
  const clientId = `app_mutation_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Mutation Authority", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "Mutation Tester", now, now),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "task", "write", "service", "svc_test_admin"),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "wish", "write", "service", "svc_test_admin"),
  ]);

  return {
    publicKey,
    accessToken: await token(privateKey, userId, clientId),
    spaceId,
    personId,
  };
}

async function jsonResource(response: Response) {
  return response.json<ResourcePayload>();
}

describe("Mutation Authority", () => {
  it("denies direct Task lifecycle writes while preserving ordinary edits and authoritative Actions", async () => {
    const f = await fixture();
    const collection = `/api/v1/spaces/${f.spaceId}/models/task/records`;

    const createBypass = await request(f.publicKey, f.accessToken, collection, {
      method: "POST",
      body: JSON.stringify({ name: "Client-selected state", status: "pending" }),
    });
    expect(createBypass.status).toBe(400);
    expect(await createBypass.json<ErrorPayload>()).toMatchObject({
      error: { code: "INVALID_RESOURCE", message: "Field status is read-only" },
    });

    const createdResponse = await request(f.publicKey, f.accessToken, collection, {
      method: "POST",
      body: JSON.stringify({ name: "Protect semantic completion" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await jsonResource(createdResponse);
    expect(created.data).toMatchObject({ version: 1, status: "pending" });

    const bypass = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, status: "completed" }),
    });
    expect(bypass.status).toBe(400);
    expect(await bypass.json<ErrorPayload>()).toMatchObject({
      error: { code: "INVALID_RESOURCE", message: "Field status is read-only" },
    });

    const ordinaryEdit = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, name: "Still editable" }),
    });
    expect(ordinaryEdit.status).toBe(200);
    const edited = await jsonResource(ordinaryEdit);
    expect(edited.data).toMatchObject({ version: 2, status: "pending", name: "Still editable" });

    const completedResponse = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}/actions/complete`, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(completedResponse.status).toBe(200);
    const completed = await jsonResource(completedResponse);
    expect(completed.data.status).toBe("completed");
    expect(completed.data.completedByType).toBe("user");
    expect(typeof completed.data.completedById).toBe("string");
    expect(typeof completed.data.completedAt).toBe("string");

    const cancelledResponse = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}/actions/cancel`, {
      method: "POST",
      body: JSON.stringify({ version: completed.data.version }),
    });
    expect(cancelledResponse.status).toBe(200);
    const cancelled = await jsonResource(cancelledResponse);
    expect(cancelled.data).toMatchObject({
      status: "cancelled",
      completedAt: null,
      completedByType: null,
      completedById: null,
    });
  });

  it("denies direct Wish lifecycle writes while preserving ordinary edits and fulfill/reopen Actions", async () => {
    const f = await fixture();
    const collection = `/api/v1/spaces/${f.spaceId}/models/wish/records`;

    const createBypass = await request(f.publicKey, f.accessToken, collection, {
      method: "POST",
      body: JSON.stringify({ title: "Client-selected wish state", ownerPersonId: f.personId, status: "open" }),
    });
    expect(createBypass.status).toBe(400);
    expect(await createBypass.json<ErrorPayload>()).toMatchObject({
      error: { code: "INVALID_RESOURCE", message: "Field status is read-only" },
    });

    const createdResponse = await request(f.publicKey, f.accessToken, collection, {
      method: "POST",
      body: JSON.stringify({ title: "See the aurora", ownerPersonId: f.personId }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await jsonResource(createdResponse);
    expect(created.data).toMatchObject({ version: 1, status: "open" });

    const bypass = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, status: "fulfilled" }),
    });
    expect(bypass.status).toBe(400);
    expect(await bypass.json<ErrorPayload>()).toMatchObject({
      error: { code: "INVALID_RESOURCE", message: "Field status is read-only" },
    });

    const ordinaryEdit = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "See the aurora in Iceland" }),
    });
    expect(ordinaryEdit.status).toBe(200);
    const edited = await jsonResource(ordinaryEdit);
    expect(edited.data).toMatchObject({ version: 2, status: "open", title: "See the aurora in Iceland" });

    const fulfilledResponse = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}/actions/fulfill`, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(fulfilledResponse.status).toBe(200);
    const fulfilled = await jsonResource(fulfilledResponse);
    expect(fulfilled.data.status).toBe("fulfilled");
    expect(typeof fulfilled.data.fulfilledAt).toBe("string");

    const reopenedResponse = await request(f.publicKey, f.accessToken, `${collection}/${created.data.id}/actions/reopen`, {
      method: "POST",
      body: JSON.stringify({ version: fulfilled.data.version }),
    });
    expect(reopenedResponse.status).toBe(200);
    const reopened = await jsonResource(reopenedResponse);
    expect(reopened.data).toMatchObject({ status: "open", fulfilledAt: null });
  });

  it("represents Action-owned mutation authority in generated contracts and Runtime Discovery", async () => {
    const contract = await getOrCreateActiveModelContract(bindings());
    const schemas = (contract.openapi.components as { schemas: Record<string, { properties?: Record<string, unknown> }> }).schemas;

    expect(schemas.TaskCreate.properties).not.toHaveProperty("status");
    expect(schemas.TaskUpdate.properties).not.toHaveProperty("status");
    expect(schemas.TaskResource.properties?.status).toMatchObject({ readOnly: true });
    expect(schemas.WishCreate.properties).not.toHaveProperty("status");
    expect(schemas.WishUpdate.properties).not.toHaveProperty("status");
    expect(schemas.WishResource.properties?.status).toMatchObject({ readOnly: true });

    const f = await fixture();
    const discoveryResponse = await request(f.publicKey, f.accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    expect(discoveryResponse.status).toBe(200);
    const discovery = await discoveryResponse.json<{ data: { models: Array<{
      key: string;
      fields: Array<{ key: string; readOnly?: boolean }>;
      actions: Array<{ key: string }>;
    }> } }>();

    const task = discovery.data.models.find((model) => model.key === "task");
    const wish = discovery.data.models.find((model) => model.key === "wish");
    expect(task?.fields.find((field) => field.key === "status")).toMatchObject({ readOnly: true });
    expect(task?.actions.map((action) => action.key).sort()).toEqual(["cancel", "complete", "reopen", "skip-occurrence"]);
    expect(wish?.fields.find((field) => field.key === "status")).toMatchObject({ readOnly: true });
    expect(wish?.actions.map((action) => action.key).sort()).toEqual(["fulfill", "reopen"]);
  });
});

