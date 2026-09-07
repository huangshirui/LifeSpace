import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { getOrCreateActiveModelContract, readModelContract } from "../src/model-contract-service";
import { publishModelDefinition, retireModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type KeyPair = { privateKey: string; publicKey: string };
type Actor = { id: string };
type Inventory = {
  models: Array<{ key: string; route: string; version: number; schemaHash: string }>;
  spaces: Array<{
    spaceId: string;
    models: Array<{ modelKey: string; access: Array<"read" | "write" | "manage"> }>;
  }>;
};
type Fixture = {
  db: D1Database;
  ownerId: string;
  memberId: string;
  memberPersonId: string;
  targetPersonId: string;
  serviceId: string;
  agentId: string;
  clientId: string;
  spaceId: string;
  modelKey: string;
  route: string;
  definition: ReturnType<typeof probeDefinition>;
};
type AuthorizationBarrier = {
  db: D1Database;
  reached: Promise<void>;
  release: () => void;
};

let keyPair: KeyPair;

beforeAll(async () => {
  keyPair = await keys();
});

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys(): Promise<KeyPair> {
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
  principalType: "user" | "service",
  principalId: string,
  clientId: string,
  scopes: string[],
  actor?: Actor,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    ...(actor ? { actor_type: "agent", actor_id: actor.id, purpose: "delegated_agent" } : {}),
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, keyPair.privateKey, "RS256");
}

function probeDefinition(modelKey: string, route: string) {
  return {
    definitionVersion: 1,
    key: modelKey,
    route,
    display: { singular: "Authority Probe", plural: "Authority Probes" },
    description: "Model-neutral fixture for current Authority state-transition conformance.",
    fields: {
      title: { type: "string", title: "Title", required: true, minLength: 1, maxLength: 120 },
      assigneePersonId: { type: "person", title: "Assignee" },
    },
    query: { searchable: ["title"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

async function fixture(): Promise<Fixture> {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const ownerId = `usr_authowner_${suffix}`;
  const memberId = `usr_authmember_${suffix}`;
  const memberPersonId = `per_authmember_${suffix}`;
  const targetPersonId = `per_authtarget_${suffix}`;
  const serviceId = `svc_auth_${suffix}`;
  const agentId = `agt_${suffix}`;
  const clientId = `app_auth_${suffix}`;
  const spaceId = `spc_auth_${suffix}`;
  const modelKey = `authority_probe_${suffix.slice(0, 8)}`;
  const route = `authority-probes-${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Dynamic Authority", ownerId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_authowner_${suffix}`, spaceId, ownerId, "owner", now, now),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_authmember_${suffix}`, spaceId, memberId, "editor", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_authowner_${suffix}`, spaceId, ownerId, "Authority Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(memberPersonId, spaceId, memberId, "Authority Member", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(targetPersonId, spaceId, null, "Target A", now, now),
  ]);

  const definition = probeDefinition(modelKey, route);
  const publisher: Principal = {
    type: "service",
    id: `svc_authpublisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_authpublisher_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, definition, "initial");
  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

  return {
    db,
    ownerId,
    memberId,
    memberPersonId,
    targetPersonId,
    serviceId,
    agentId,
    clientId,
    spaceId,
    modelKey,
    route,
    definition,
  };
}

function auth(accessToken: string, json = false): Headers {
  const headers = new Headers({ authorization: `Bearer ${accessToken}` });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function request(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  database: D1Database = (env as unknown as TestEnv).DB,
): Promise<Response> {
  const headers = auth(accessToken, Boolean(init.body));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: database,
    IDENTITY_PUBLIC_KEY: keyPair.publicKey,
    ENVIRONMENT: "test",
  });
}

async function data<T>(response: Response, expectedStatus = 200): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  return (await response.json<{ data: T }>()).data;
}

async function errorCode(response: Response, expectedStatus: number): Promise<string> {
  expect(response.status).toBe(expectedStatus);
  return (await response.json<{ error: { code: string } }>()).error.code;
}

function inventoryEdge(inventory: Inventory, fixtureValue: Fixture) {
  return inventory.spaces
    .find((space) => space.spaceId === fixtureValue.spaceId)
    ?.models.find((model) => model.modelKey === fixtureValue.modelKey);
}

async function inventory(f: Fixture, bearer: string, database = f.db): Promise<Inventory> {
  return data<Inventory>(await request(bearer, "/api/v1/me/_discovery/inventory", {}, database));
}

async function createProbe(
  f: Fixture,
  bearer: string,
  title: string,
  database = f.db,
  assigneePersonId?: string,
): Promise<Response> {
  return request(bearer, `/api/v1/spaces/${f.spaceId}/${f.route}`, {
    method: "POST",
    body: JSON.stringify({ title, ...(assigneePersonId ? { assigneePersonId } : {}) }),
  }, database);
}

async function listProbes(f: Fixture, bearer: string, database = f.db): Promise<Response> {
  return request(bearer, `/api/v1/spaces/${f.spaceId}/${f.route}`, {}, database);
}

async function ownerToken(f: Fixture): Promise<string> {
  return token("user", f.ownerId, f.clientId, ["resources:read", "resources:write", "grants:manage"]);
}

async function memberToken(f: Fixture): Promise<string> {
  return token("user", f.memberId, f.clientId, ["resources:read", "resources:write"]);
}

async function serviceToken(f: Fixture): Promise<string> {
  return token("service", f.serviceId, f.clientId, ["resources:read", "resources:write"]);
}

async function agentToken(f: Fixture): Promise<string> {
  return token("user", f.memberId, f.clientId, ["resources:read", "resources:write"], { id: f.agentId });
}

async function createModelGrant(f: Fixture, permission: "read" | "write"): Promise<string> {
  const response = await request(await ownerToken(f), `/api/v1/spaces/${f.spaceId}/grants`, {
    method: "POST",
    body: JSON.stringify({
      granteeType: "service",
      granteeId: f.serviceId,
      resourceType: "model",
      resourceId: f.modelKey,
      permission,
    }),
  });
  return (await data<{ id: string }>(response, 201)).id;
}

async function createDelegation(f: Fixture, maxAccess: "read" | "write"): Promise<string> {
  const response = await request(await memberToken(f), `/api/v1/spaces/${f.spaceId}/agent-delegations`, {
    method: "POST",
    body: JSON.stringify({
      agentId: f.agentId,
      models: [{ modelKey: f.modelKey, maxAccess }],
    }),
  });
  return (await data<{ id: string }>(response, 201)).id;
}

function authorizationBarrier(database: D1Database): AuthorizationBarrier {
  const statementTargets = new WeakMap<object, D1PreparedStatement>();
  const statementSql = new WeakMap<object, string>();
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let armed = true;
  const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });

  function trackedStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement as object, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => trackedStatement(statement.bind(...values), sql);
        }
        const value = Reflect.get(target, property, statement);
        return typeof value === "function" ? value.bind(statement) : value;
      },
    }) as D1PreparedStatement;
    statementTargets.set(proxy as unknown as object, statement);
    statementSql.set(proxy as unknown as object, sql);
    return proxy;
  }

  const db = new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => trackedStatement(database.prepare(sql), sql);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((statement) => statementSql.get(statement as unknown as object) ?? "");
          const isModelAuthorityRead = sql.some((value) => value.includes("FROM application_model_access"))
            && sql.some((value) => value.includes("FROM data_grants"))
            && sql.some((value) => value.includes("FROM spaces"));
          if (armed && isModelAuthorityRead) {
            armed = false;
            reachedResolve();
            await released;
          }
          return database.batch(statements.map((statement) => statementTargets.get(statement as unknown as object) ?? statement));
        };
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;

  return { db, reached, release: () => releaseResolve() };
}

async function waitForBarrier(barrier: AuthorizationBarrier): Promise<void> {
  await Promise.race([
    barrier.reached,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("authoritative model-access barrier was not reached")), 3000)),
  ]);
}

describe("Dynamic Authority state-transition conformance", () => {
  it("tracks Membership downgrade/removal in fresh projection and subsequent execution", async () => {
    const f = await fixture();
    const bearer = await memberToken(f);

    expect(inventoryEdge(await inventory(f, bearer), f)?.access).toEqual(["read", "write"]);
    expect((await createProbe(f, bearer, "membership-before")).status).toBe(201);

    await f.db.prepare("UPDATE space_memberships SET role='viewer',updated_at=? WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
      .bind(new Date().toISOString(), f.spaceId, f.memberId).run();

    expect(inventoryEdge(await inventory(f, bearer), f)?.access).toEqual(["read"]);
    expect((await listProbes(f, bearer)).status).toBe(200);
    expect(await errorCode(await createProbe(f, bearer, "membership-after-downgrade"), 403)).toBe("FORBIDDEN");

    const removedAt = new Date().toISOString();
    await f.db.prepare("UPDATE space_memberships SET deleted_at=?,updated_at=? WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
      .bind(removedAt, removedAt, f.spaceId, f.memberId).run();

    expect(inventoryEdge(await inventory(f, bearer), f)).toBeUndefined();
    expect(await errorCode(await listProbes(f, bearer), 403)).toBe("FORBIDDEN");
  });

  it("tracks Data Grant downgrade/revoke through real Kernel mutation routes", async () => {
    const f = await fixture();
    const grantId = await createModelGrant(f, "write");
    const service = await serviceToken(f);
    const owner = await ownerToken(f);

    expect(inventoryEdge(await inventory(f, service), f)?.access).toEqual(["read", "write"]);
    expect((await createProbe(f, service, "grant-before")).status).toBe(201);

    const downgraded = await request(owner, `/api/v1/spaces/${f.spaceId}/grants/${grantId}`, {
      method: "PATCH",
      body: JSON.stringify({ permission: "read" }),
    });
    expect(downgraded.status).toBe(200);

    expect(inventoryEdge(await inventory(f, service), f)?.access).toEqual(["read"]);
    expect((await listProbes(f, service)).status).toBe(200);
    expect(await errorCode(await createProbe(f, service, "grant-after-downgrade"), 403)).toBe("FORBIDDEN");

    const revoked = await request(owner, `/api/v1/spaces/${f.spaceId}/grants/${grantId}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect(inventoryEdge(await inventory(f, service), f)).toBeUndefined();
    expect(await errorCode(await listProbes(f, service), 403)).toBe("FORBIDDEN");
  });

  it("keeps Application × Model Access as a current ceiling even while Membership remains write-capable", async () => {
    const f = await fixture();
    const bearer = await memberToken(f);

    expect((await createProbe(f, bearer, "catalog-before")).status).toBe(201);
    await f.db.prepare("UPDATE application_model_access SET max_access='read' WHERE application_id=? AND model_key=?")
      .bind(f.clientId, f.modelKey).run();

    expect(inventoryEdge(await inventory(f, bearer), f)?.access).toEqual(["read"]);
    expect((await listProbes(f, bearer)).status).toBe(200);
    expect(await errorCode(await createProbe(f, bearer, "catalog-after-downgrade"), 403)).toBe("FORBIDDEN");

    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?")
      .bind(f.clientId, f.modelKey).run();
    expect(inventoryEdge(await inventory(f, bearer), f)).toBeUndefined();
    expect(await errorCode(await listProbes(f, bearer), 403)).toBe("FORBIDDEN");
  });

  it("narrows and revokes an already-issued delegated-Agent credential from current Delegation state", async () => {
    const f = await fixture();
    const delegationId = await createDelegation(f, "write");
    const delegated = await agentToken(f);
    const direct = await memberToken(f);

    expect(inventoryEdge(await inventory(f, delegated), f)?.access).toEqual(["read", "write"]);
    expect((await createProbe(f, delegated, "delegation-before")).status).toBe(201);

    await f.db.prepare("UPDATE agent_delegation_models SET max_access='read' WHERE delegation_id=? AND model_key=?")
      .bind(delegationId, f.modelKey).run();
    expect(inventoryEdge(await inventory(f, delegated), f)?.access).toEqual(["read"]);
    expect((await listProbes(f, delegated)).status).toBe(200);
    expect(await errorCode(await createProbe(f, delegated, "delegation-after-downgrade"), 403)).toBe("FORBIDDEN");

    const revoked = await request(direct, `/api/v1/spaces/${f.spaceId}/agent-delegations/${delegationId}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect(inventoryEdge(await inventory(f, delegated), f)).toBeUndefined();
    expect(await errorCode(await listProbes(f, delegated), 403)).toBe("FORBIDDEN");
  });

  it("advances current Model identity on publication, removes it on retirement and preserves old immutable contract evidence", async () => {
    const f = await fixture();
    const bearer = await memberToken(f);
    const publisher: Principal = {
      type: "service",
      id: `svc_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`,
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: `tok_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`,
    };
    const bindings = { DB: f.db } as Bindings;

    const beforeInventory = await inventory(f, bearer);
    const beforeModel = beforeInventory.models.find((model) => model.key === f.modelKey)!;
    const oldContract = await getOrCreateActiveModelContract(bindings);

    const v2Definition = {
      ...f.definition,
      fields: {
        ...f.definition.fields,
        note: { type: "string", title: "Note", maxLength: 200 },
      },
    };
    const v2 = await publishModelDefinition(bindings, publisher, v2Definition, "compatible");
    expect(v2.version).toBe(beforeModel.version + 1);
    expect(v2.schemaHash).not.toBe(beforeModel.schemaHash);

    const afterPublish = await inventory(f, bearer);
    const afterModel = afterPublish.models.find((model) => model.key === f.modelKey)!;
    expect({ version: afterModel.version, schemaHash: afterModel.schemaHash }).toEqual({
      version: v2.version,
      schemaHash: v2.schemaHash,
    });
    const detail = await data<{ key: string; version: number; schemaHash: string }>(await request(
      bearer,
      `/api/v1/spaces/${f.spaceId}/_discovery/models/${f.modelKey}`,
    ));
    expect(detail).toMatchObject({ key: f.modelKey, version: v2.version, schemaHash: v2.schemaHash });
    expect((await readModelContract(bindings, oldContract.id)).id).toBe(oldContract.id);

    await retireModel(bindings, publisher, f.modelKey);
    expect(inventoryEdge(await inventory(f, bearer), f)).toBeUndefined();
    expect((await listProbes(f, bearer)).status).toBe(404);
    expect((await readModelContract(bindings, oldContract.id)).id).toBe(oldContract.id);
  });

  it("refreshes Person relation labels/removal and rejects a stale cached target ID at mutation time", async () => {
    const f = await fixture();
    const bearer = await memberToken(f);
    const lookupPath = `/api/v1/spaces/${f.spaceId}/_relation-targets/${f.modelKey}/assigneePersonId`;

    const first = await data<{ items: Array<{ id: string; label: string }> }>(await request(bearer, lookupPath));
    expect(first.items).toContainEqual({ id: f.targetPersonId, label: "Target A" });
    const cachedId = f.targetPersonId;

    await f.db.prepare("UPDATE space_people SET display_name=?,updated_at=? WHERE id=? AND space_id=? AND deleted_at IS NULL")
      .bind("Target B", new Date().toISOString(), f.targetPersonId, f.spaceId).run();
    const renamed = await data<{ items: Array<{ id: string; label: string }> }>(await request(bearer, lookupPath));
    expect(renamed.items).toContainEqual({ id: f.targetPersonId, label: "Target B" });

    const deletedAt = new Date().toISOString();
    await f.db.prepare("UPDATE space_people SET deleted_at=?,updated_at=? WHERE id=? AND space_id=? AND deleted_at IS NULL")
      .bind(deletedAt, deletedAt, f.targetPersonId, f.spaceId).run();
    const removed = await data<{ items: Array<{ id: string; label: string }> }>(await request(bearer, lookupPath));
    expect(removed.items.some((item) => item.id === f.targetPersonId)).toBe(false);

    expect(await errorCode(await createProbe(f, bearer, "stale-relation-target", f.db, cachedId), 400))
      .toBe("INVALID_RESOURCE_RELATION");
  });
});

describe("Dynamic Authority commit boundary", () => {
  it("observes a Data Grant revoke committed before the authoritative model-access read", async () => {
    const f = await fixture();
    const grantId = await createModelGrant(f, "write");
    const bearer = await serviceToken(f);
    const barrier = authorizationBarrier(f.db);

    const pending = createProbe(f, bearer, "grant-race", barrier.db);
    await waitForBarrier(barrier);
    try {
      await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
        .bind(new Date().toISOString(), grantId).run();
    } finally {
      barrier.release();
    }

    expect(await errorCode(await pending, 403)).toBe("FORBIDDEN");
  });

  it("observes an Application × Model reduction committed before the authoritative model-access read", async () => {
    const f = await fixture();
    const bearer = await memberToken(f);
    const barrier = authorizationBarrier(f.db);

    const pending = createProbe(f, bearer, "catalog-race", barrier.db);
    await waitForBarrier(barrier);
    try {
      await f.db.prepare("UPDATE application_model_access SET max_access='read' WHERE application_id=? AND model_key=?")
        .bind(f.clientId, f.modelKey).run();
    } finally {
      barrier.release();
    }

    expect(await errorCode(await pending, 403)).toBe("FORBIDDEN");
  });

  it("observes an Agent Delegation revoke committed before the authoritative model-access read", async () => {
    const f = await fixture();
    const delegationId = await createDelegation(f, "write");
    const bearer = await agentToken(f);
    const barrier = authorizationBarrier(f.db);

    const pending = createProbe(f, bearer, "delegation-race", barrier.db);
    await waitForBarrier(barrier);
    try {
      await f.db.prepare("UPDATE agent_delegations SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
        .bind(new Date().toISOString(), delegationId).run();
    } finally {
      barrier.release();
    }

    expect(await errorCode(await pending, 403)).toBe("FORBIDDEN");
  });
});
