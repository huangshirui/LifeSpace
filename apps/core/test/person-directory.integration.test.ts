import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource, deleteGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type PersonDto = {
  id: string;
  displayName: string;
  alternateNames: string[];
  linkedUser: boolean;
  version: number;
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

async function userToken(privateKey: string, userId: string, clientId: string, scopes = "resources:read resources:write") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: scopes,
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function representedAgentToken(
  privateKey: string,
  userId: string,
  agentId: string,
  clientId: string,
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: agentId,
    azp: clientId,
    principal_type: "user",
    principal_id: userId,
    actor_type: "agent",
    actor_id: agentId,
    purpose: "agent_execution",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function bindings(db: D1Database): Bindings {
  return { DB: db } as Bindings;
}

async function request(
  publicKey: string,
  token: string,
  path: string,
  init: RequestInit = {},
  delegationId?: string,
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  if (delegationId) headers.set("x-lifespace-delegation-id", delegationId);
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture(role: "owner" | "viewer" = "owner") {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_person_dir_${suffix}`;
  const clientId = `app_person_dir_${suffix}`;
  const spaceId = `spc_person_dir_${suffix}`;
  const linkedPersonId = `per_person_dir_${suffix}`;
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Person Directory", userId, timestamp, timestamp, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_person_dir_${suffix}`, spaceId, userId, role, timestamp, timestamp),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(linkedPersonId, spaceId, userId, "Current User", timestamp, timestamp),
  ]);
  const auth = await keys();
  const token = await userToken(auth.privateKey, userId, clientId);
  return { db, ...auth, token, userId, clientId, spaceId, linkedPersonId, timestamp };
}

async function createPerson(
  f: Awaited<ReturnType<typeof fixture>>,
  displayName: string,
  alternateNames: string[] = [],
) {
  const response = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people`, {
    method: "POST",
    body: JSON.stringify({ displayName, alternateNames }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: PersonDto }>()).data;
}

async function insertSingleUseDelegation(
  f: Awaited<ReturnType<typeof fixture>>,
  agentId: string,
  suffix: string,
) {
  const delegationId = `dlg_person_dir_${suffix}`;
  await f.db.batch([
    f.db.prepare(`INSERT INTO delegations(
      id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
      created_by_type,created_by_id,created_at,max_uses,parent_delegation_id,remaining_redelegation_depth
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL,0)`).bind(
      delegationId,
      "user",
      f.userId,
      "agent",
      agentId,
      f.clientId,
      f.spaceId,
      "user",
      f.userId,
      f.timestamp,
    ),
    f.db.prepare(`INSERT INTO delegation_scopes(
      delegation_id,target_type,target_id,target_model_key,max_access
    ) VALUES(?,'space',?,NULL,'write')`).bind(delegationId, f.spaceId),
  ]);
  return delegationId;
}

describe("Space Person Directory", () => {
  it("creates, searches and atomically applies incremental alternate-name mutations with optimistic concurrency", async () => {
    const f = await fixture();
    const created = await createPerson(f, "黄小天", ["小天", "Harry"]);
    expect(created).toMatchObject({
      displayName: "黄小天",
      alternateNames: ["Harry", "小天"],
      linkedUser: false,
      version: 1,
    });

    const byAlias = await request(
      f.publicKey,
      f.token,
      `/api/v1/spaces/${f.spaceId}/people?q=harry`,
    );
    expect(byAlias.status).toBe(200);
    expect((await byAlias.json<{ data: { items: PersonDto[] } }>()).data.items).toEqual([
      expect.objectContaining({ id: created.id, displayName: "黄小天" }),
    ]);

    const updated = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "黄天",
        alternateNames: {
          add: ["天天"],
          remove: ["小天"],
          rename: [{ from: "Harry", to: "Henry" }],
        },
        version: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: PersonDto }>()).data).toMatchObject({
      id: created.id,
      displayName: "黄天",
      alternateNames: ["Henry", "天天"],
      version: 2,
    });

    const stale = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Stale", version: 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("PERSON_VERSION_CONFLICT");

    const model = await getPublishedModel(bindings(f.db), "task");
    if (!model) throw new Error("Task model is missing");
    const principal: Principal = {
      type: "user",
      id: f.userId,
      clientId: f.clientId,
      scopes: ["resources:read", "resources:write"],
      tokenId: `tok_${crypto.randomUUID()}`,
    };
    const task = await createGenericResource(bindings(f.db), principal, f.spaceId, model, {
      name: "References Person",
      assigneePersonIds: [created.id],
    });

    const inUse = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: 2 }),
    });
    expect(inUse.status).toBe(409);
    expect((await inUse.json<{ error: { code: string } }>()).error.code).toBe("PERSON_IN_USE");

    await deleteGenericResource(bindings(f.db), principal, f.spaceId, model, task.id, 1);
    const deleted = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "DELETE",
      body: JSON.stringify({ version: 2 }),
    });
    expect(deleted.status).toBe(204);

    const changeRows = await f.db.prepare(`SELECT operation,version_before,version_after
      FROM space_person_changes WHERE person_id=? ORDER BY version_after`)
      .bind(created.id)
      .all<{ operation: string; version_before: number | null; version_after: number }>();
    expect(changeRows.results).toEqual([
      { operation: "create", version_before: null, version_after: 1 },
      { operation: "update", version_before: 1, version_after: 2 },
      { operation: "delete", version_before: 2, version_after: 3 },
    ]);
  });

  it("supports full set replacement and requires explicit alias removal when promoting an alias to displayName", async () => {
    const f = await fixture();
    const created = await createPerson(f, "黄小天", ["小天", "Harry"]);

    const implicitPromotion = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "小天", version: 1 }),
    });
    expect(implicitPromotion.status).toBe(422);

    const promoted = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "小天",
        alternateNames: { remove: ["小天"] },
        version: 1,
      }),
    });
    expect(promoted.status).toBe(200);
    expect((await promoted.json<{ data: PersonDto }>()).data).toMatchObject({
      displayName: "小天",
      alternateNames: ["Harry"],
      version: 2,
    });

    const replaced = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        alternateNames: { set: ["天天", "Henry"] },
        version: 2,
      }),
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json<{ data: PersonDto }>()).data).toMatchObject({
      alternateNames: ["Henry", "天天"],
      version: 3,
    });

    const mixedSet = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        alternateNames: { set: ["A"], add: ["B"] },
        version: 3,
      }),
    });
    expect(mixedSet.status).toBe(422);

    const duplicateAdd = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        alternateNames: { add: ["Henry"] },
        version: 3,
      }),
    });
    expect(duplicateAdd.status).toBe(422);
  });

  it("allows viewer self-service but keeps other Person and membership-bound lifecycle protected", async () => {
    const f = await fixture("viewer");

    const selfUpdate = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${f.linkedPersonId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "My Space Name", alternateNames: { set: ["Me"] }, version: 1 }),
    });
    expect(selfUpdate.status).toBe(200);
    expect((await selfUpdate.json<{ data: PersonDto }>()).data.version).toBe(2);

    const cannotCreate = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Someone Else" }),
    });
    expect(cannotCreate.status).toBe(403);

    const cannotDeleteLinked = await request(f.publicKey, f.token, `/api/v1/spaces/${f.spaceId}/people/${f.linkedPersonId}`, {
      method: "DELETE",
      body: JSON.stringify({ version: 2 }),
    });
    expect(cannotDeleteLinked.status).toBe(403);

    const before = await f.db.prepare("SELECT version FROM space_people WHERE id=?")
      .bind(f.linkedPersonId).first<{ version: number }>();
    await f.db.prepare("UPDATE space_people SET deleted_at=?,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), new Date().toISOString(), f.linkedPersonId).run();
    const after = await f.db.prepare("SELECT version FROM space_people WHERE id=?")
      .bind(f.linkedPersonId).first<{ version: number }>();
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("atomically consumes a single-use Space Delegation only when a Person mutation commits", async () => {
    const f = await fixture();
    const agentId = `agt_person_dir_${crypto.randomUUID().replaceAll("-", "")}`;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const delegationId = await insertSingleUseDelegation(f, agentId, suffix);
    const token = await representedAgentToken(f.privateKey, f.userId, agentId, f.clientId);

    const created = await request(f.publicKey, token, `/api/v1/spaces/${f.spaceId}/people`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Delegated Person", alternateNames: ["DP"] }),
    }, delegationId);
    expect(created.status).toBe(201);

    const consumed = await f.db.prepare(`SELECT consumed_at,consumed_by_change_id
      FROM delegations WHERE id=?`).bind(delegationId).first<{ consumed_at: string | null; consumed_by_change_id: string | null }>();
    expect(consumed?.consumed_at).not.toBeNull();
    expect(consumed?.consumed_by_change_id).toMatch(/^pchg_/u);

    const evidence = await f.db.prepare(`SELECT d.delegation_id
      FROM space_person_change_delegations d
      JOIN space_person_changes c ON c.id=d.change_id
      WHERE c.person_id=?`).bind((await created.json<{ data: PersonDto }>()).data.id)
      .first<{ delegation_id: string }>();
    expect(evidence?.delegation_id).toBe(delegationId);

    const reused = await request(f.publicKey, token, `/api/v1/spaces/${f.spaceId}/people`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Must Fail" }),
    }, delegationId);
    expect(reused.status).toBe(403);
    expect((await reused.json<{ error: { code: string } }>()).error.code).toBe("DELEGATION_INVALID");
  });
  it("grants direct Agents Person Directory read/write without Space or ordinary-model Authority", async () => {
    const f = await fixture();
    const agentId = `agt_dir_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = await userToken(f.privateKey, f.userId, f.clientId,
      "resources:read resources:write grants:manage");
    const iat = Math.floor(Date.now() / 1000);
    const directAgent = await sign({
      iss: "lifespace-identity", aud: "lifespace-core", sub: agentId,
      azp: f.clientId, principal_type: "agent", principal_id: agentId,
      actor_type: "agent", actor_id: agentId, purpose: "agent_execution",
      scope: "resources:read resources:write spaces:read",
      iat, exp: iat + 900, jti: `tok_${crypto.randomUUID()}`,
    }, f.privateKey, "RS256");
    const directory = `/api/v1/spaces/${f.spaceId}/people`;
    const agentRequest = (path: string, init: RequestInit = {}) => request(f.publicKey, directAgent, path, init);
    expect((await agentRequest(directory)).status).toBe(403);

    const invalid = await request(f.publicKey, admin, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST", body: JSON.stringify({ granteeType: "agent", granteeId: agentId,
        resourceType: "person_directory", resourceId: "task", permission: "read" }),
    });
    expect(invalid.status).toBe(422);
    for (const permission of ["free_busy", "manage"]) {
      const denied = await request(f.publicKey, admin, `/api/v1/spaces/${f.spaceId}/grants`, {
        method: "POST", body: JSON.stringify({ granteeType: "agent", granteeId: agentId,
          resourceType: "person_directory", permission }),
      });
      expect(denied.status).toBe(422);
    }

    const createGrant = await request(f.publicKey, admin, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST", body: JSON.stringify({ granteeType: "agent", granteeId: agentId,
        resourceType: "person_directory", resourceId: null, permission: "read" }),
    });
    expect(createGrant.status).toBe(201);
    const grant = (await createGrant.json<{ data: { id: string; resourceType: string; resourceId: string | null } }>()).data;
    expect(grant).toMatchObject({ resourceType: "person_directory", resourceId: null });
    expect((await agentRequest(directory)).status).toBe(200);
    expect((await agentRequest(`/api/v1/spaces/${f.spaceId}`)).status).toBe(403);
    expect((await agentRequest(directory, { method: "POST", body: JSON.stringify({ displayName: "Not Yet" }) })).status).toBe(403);

    const elevate = await request(f.publicKey, admin, `/api/v1/spaces/${f.spaceId}/grants/${grant.id}`, {
      method: "PATCH", body: JSON.stringify({ permission: "write" }),
    });
    expect(elevate.status).toBe(200);
    const created = await agentRequest(directory, { method: "POST", body: JSON.stringify({ displayName: "External Person" }) });
    expect(created.status).toBe(201);
    const person = (await created.json<{ data: PersonDto }>()).data;
    const updated = await agentRequest(`${directory}/${person.id}`, {
      method: "PATCH", body: JSON.stringify({ displayName: "Renamed", version: person.version }),
    });
    expect(updated.status).toBe(200);
    // Linked family member Person remains protected by Space manage authority.
    expect((await agentRequest(`${directory}/${f.linkedPersonId}`, {
      method: "PATCH", body: JSON.stringify({ displayName: "Must Deny", version: 1 }),
    })).status).toBe(403);
    const modelPath = `/api/v1/spaces/${f.spaceId}/models/task/records`;
    expect((await agentRequest(modelPath)).status).toBe(403);
    expect((await agentRequest(`/api/v1/spaces/${f.spaceId}/members`)).status).toBe(403);

    const revoke = await request(f.publicKey, admin, `/api/v1/spaces/${f.spaceId}/grants/${grant.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);
    expect((await agentRequest(directory)).status).toBe(403);
    expect((await agentRequest(directory, { method: "POST", body: JSON.stringify({ displayName: "Revoked" }) })).status).toBe(403);
  });

});
