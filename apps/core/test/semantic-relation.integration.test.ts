import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { getRuntimeModel, publishModelDefinition } from "../src/model-registry";
import { typedInsertStatement } from "../src/typed-resource-storage";
import { countingDatabase, type DatabaseCost } from "./support/counting-database";

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
  bearer: string,
  path: string,
  init: RequestInit = {},
  bindings: Partial<Bindings> = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    ...bindings,
  });
}

async function json(response: Response) {
  return response.json<any>();
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const clientId = `app_semrel_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const sourceModelKey = `semantic_source_${suffix.slice(0, 8)}`;
  const targetModelKey = `semantic_target_${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "Semantic Relation", userId, now, now, "UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`per_${suffix}`, spaceId, userId, "Owner", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_semrel_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: sourceModelKey,
    display: { singular: "Semantic Source", plural: "Semantic Sources" },
    fields: { name: { type: "string", required: true } },
    semanticRelations: { outgoing: ["relates_to"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: targetModelKey,
    display: { singular: "Semantic Target", plural: "Semantic Targets" },
    fields: { name: { type: "string", required: true } },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");
  await db.batch([
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, sourceModelKey, "write", "service", publisher.id),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, targetModelKey, "write", "service", publisher.id),
  ]);

  return {
    db,
    userId,
    privateKey,
    publicKey,
    bearer: await token(privateKey, userId, clientId),
    clientId,
    spaceId,
    sourceModelKey,
    targetModelKey,
  };
}

async function createRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  modelKey: string,
  name: string,
) {
  const response = await request(
    f.publicKey,
    f.bearer,
    `/api/v1/spaces/${f.spaceId}/models/${modelKey}/records`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  expect(response.status).toBe(201);
  return (await json(response)).data as { id: string; version: number };
}

async function delegation(f: Awaited<ReturnType<typeof fixture>>, agentId: string, singleUse = false,
  scope: { type: "space" | "record"; id: string; modelKey?: string } = { type: "space", id: f.spaceId }) {
  const id = `dlg_${crypto.randomUUID().replaceAll("-", "")}`;
  await f.db.batch([
    f.db.prepare(`INSERT INTO delegations(id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
      created_by_type,created_by_id,created_at,max_uses) VALUES(?,'user',?,'agent',?,?,?,'user',?,?,?)`)
      .bind(id, f.userId, agentId, f.clientId, f.spaceId, f.userId, new Date().toISOString(), singleUse ? 1 : null),
    f.db.prepare("INSERT INTO delegation_scopes(delegation_id,target_type,target_id,target_model_key,max_access) VALUES(?,?,?,?,?)")
      .bind(id, scope.type, scope.id, scope.modelKey ?? null, "write"),
  ]);
  return id;
}

function opaqueIdentity(principal: Principal, calls: { count: number }): Partial<Bindings> {
  return { CORE_IDENTITY_SHARED_SECRET: "test-semantic-internal-secret", IDENTITY: {
    async fetch() { calls.count += 1; return Response.json({ data: { active: true, audience: "lifespace-core", principal } }); },
  } as Fetcher };
}

describe("Semantic Relation Runtime", () => {
  it("keeps per-item atomicity in the bounded non-atomic endpoint-contention replay", async () => {
    for (const atomicConsistency of [true, false]) {
      const f = await fixture(); const target = await createRecord(f, f.targetModelKey, "target");
      let deleted = false;
      const db = countingDatabase(f.db, { roundTrips: 0, rowsRead: 0, sql: [] }, async sql => {
        if (!deleted && sql.some(text => text.includes("INSERT OR IGNORE INTO semantic_relations"))) {
          deleted = true;
          const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/${f.targetModelKey}/records/${target.id}`,
            { method: "DELETE", body: JSON.stringify({ version: target.version }) });
          expect(response.status).toBe(204);
        }
      });
      const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", body: JSON.stringify({
        atomicConsistency, operations: [
          { operation: "create", modelKey: f.sourceModelKey, data: { name: "dependent" }, semanticRelations: [
            { predicate: "relates_to", target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } },
          ] },
          { operation: "create", modelKey: f.sourceModelKey, data: { name: "independent" } },
        ],
      }) }, { DB: db });
      expect(deleted).toBe(true);
      expect(response.status).toBe(atomicConsistency ? 404 : 200);
      if (!atomicConsistency) expect((await json(response)).data.items.map((item: any) => item.status)).toEqual(["failed", "succeeded"]);
      expect(await f.db.prepare("SELECT COUNT(*) count FROM resource_records WHERE space_id=? AND model_key=?").bind(f.spaceId, f.sourceModelKey).first("count"))
        .toBe(atomicConsistency ? 0 : 1);
      expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relations WHERE space_id=?").bind(f.spaceId).first("count")).toBe(0);
    }
  });

  it("allows only one non-atomic relation action to consume a repeated single-use grant", async () => {
    const f = await fixture(); const source = await createRecord(f, f.sourceModelKey, "source");
    const targets = await Promise.all(["first", "second"].map(name => createRecord(f, f.targetModelKey, name)));
    const agent: Principal = { type: "agent", id: `agt_${f.userId.slice(4)}`, clientId: f.clientId,
      scopes: ["resources:read", "resources:write"], tokenId: "tok_agent", purpose: "agent_api" };
    const dlg = await delegation(f, agent.id, true);
    const response = await request(f.publicKey, "lsp_agt_test", `/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", body: JSON.stringify({
      atomicConsistency: false, delegationId: dlg, operations: targets.map(target => ({ operation: "relation_create", predicate: "relates_to",
        source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
        target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } })),
    }) }, opaqueIdentity(agent, { count: 0 }));
    const data = (await json(response)).data;
    expect(response.status).toBe(200); expect(data.items.map((item: any) => item.status)).toEqual(["succeeded", "failed"]);
    expect(data.items[1].error.code).toBe("DELEGATION_INVALID");
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relations WHERE space_id=?").bind(f.spaceId).first("count")).toBe(1);
    expect(await f.db.prepare("SELECT succeeded_count FROM resource_bulk_requests WHERE id=?").bind(data.bulkId).first("succeeded_count")).toBe(1);
  });
  it("requires source write and target read, without requiring target write", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source"); const target = await createRecord(f, f.targetModelKey, "target");
    await f.db.prepare("UPDATE application_model_access SET max_access='read' WHERE application_id=? AND model_key=?").bind(f.clientId, f.targetModelKey).run();
    const input = { source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id }, predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } };
    const first = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/semantic-relations`, { method: "POST", body: JSON.stringify(input) });
    expect(first.status).toBe(200);
    await f.db.prepare("UPDATE application_model_access SET max_access='read' WHERE application_id=? AND model_key=?").bind(f.clientId, f.sourceModelKey).run();
    const retry = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/semantic-relations`, { method: "POST", body: JSON.stringify(input) });
    expect(retry.status).toBe(403);
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relation_changes WHERE space_id=?").bind(f.spaceId).first("count")).toBe(1);
  });

  it("keeps 20 mixed record/edge actions bounded for User JWT, Service Token and represented Agent Token", async () => {
    const f = await fixture();
    const target = await createRecord(f, f.targetModelKey, "target");
    const calls = { count: 0 };
    const service: Principal = { type: "service", id: `svc_${f.userId.slice(4)}`, clientId: f.clientId,
      scopes: ["resources:read", "resources:write"], tokenId: "tok_service" };
    await f.db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at)
      VALUES(?,?,'service',?,'space',NULL,'write',?,?)`).bind(`grt_${f.userId.slice(4)}`, f.spaceId, service.id, f.userId, new Date().toISOString()).run();
    const agent: Principal = { type: "agent", id: `agt_${f.userId.slice(4)}`, clientId: f.clientId,
      scopes: ["resources:read", "resources:write"], tokenId: "tok_agent", purpose: "agent_api" };
    const dlg = await delegation(f, agent.id);
    for (const profile of [
      { name: "User JWT", bearer: f.bearer, identity: {} as Partial<Bindings>, extraRTT: 0, dlg: null },
      { name: "Service Token", bearer: "lsp_svc_test_semantic", identity: opaqueIdentity(service, calls), extraRTT: 0, dlg: null },
      { name: "Agent Token", bearer: "lsp_agt_test_semantic", identity: opaqueIdentity(agent, calls), extraRTT: 1, dlg },
    ]) {
      const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] }; const db = countingDatabase(f.db, cost);
      await getRuntimeModel({ DB: db } as Bindings, f.sourceModelKey); cost.roundTrips = 0; cost.sql = [];
      const identityCalls = calls.count;
      const operations = Array.from({ length: 10 }, (_, index) => [
        { operation: "create", modelKey: f.sourceModelKey, clientRef: `source${index}`, data: { name: `${profile.name} ${index}` } },
        { operation: "relation_create", source: { kind: "record", modelKey: f.sourceModelKey, clientRef: `source${index}` },
          predicate: "relates_to", target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } },
      ]).flat();
      const response = await request(f.publicKey, profile.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST", body: JSON.stringify({ operations, atomicConsistency: true, ...(profile.dlg ? { delegationId: profile.dlg } : {}) }),
      }, { ...profile.identity, DB: db });
      const result = await json(response); expect(result).not.toHaveProperty("error"); expect(response.status).toBe(200);
      expect(result.data.items).toHaveLength(20); expect(cost.roundTrips).toBe(3 + profile.extraRTT);
      expect(cost.sql.filter(sql => sql.includes("AS space_exists"))).toHaveLength(2);
      expect(calls.count - identityCalls).toBe(profile.name === "User JWT" ? 0 : 1);
    }
  });

  it("consumes single-use relation authority atomically and rejects later or revoked use", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source"); const target = await createRecord(f, f.targetModelKey, "target");
    const agent: Principal = { type: "agent", id: `agt_${f.userId.slice(4)}`, clientId: f.clientId,
      scopes: ["resources:read", "resources:write"], tokenId: "tok_agent", purpose: "agent_api" };
    const identity = opaqueIdentity(agent, { count: 0 }); const dlg = await delegation(f, agent.id, true);
    const edge = { source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id }, predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } };
    const init = { method: "POST", headers: { "x-lifespace-delegation-id": dlg }, body: JSON.stringify(edge) };
    const responses = await Promise.all([1, 2].map(() => request(f.publicKey, "lsp_agt_test", `/api/v1/spaces/${f.spaceId}/semantic-relations`, init, identity)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect((await f.db.prepare("SELECT consumed_at FROM delegations WHERE id=?").bind(dlg).first<any>()).consumed_at).not.toBeNull();
    const revoked = await delegation(f, agent.id);
    await f.db.prepare("UPDATE delegations SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), revoked).run();
    const denied = await request(f.publicKey, "lsp_agt_test", `/api/v1/spaces/${f.spaceId}/semantic-relations`, { ...init, headers: { "x-lifespace-delegation-id": revoked } }, identity);
    expect(denied.status).toBe(403);
    const recordScope = await delegation(f, agent.id, false, { type: "record", id: source.id, modelKey: f.sourceModelKey });
    const narrow = await request(f.publicKey, "lsp_agt_test", `/api/v1/spaces/${f.spaceId}/semantic-relations`, { ...init, headers: { "x-lifespace-delegation-id": recordScope } }, identity);
    expect(narrow.status).toBe(403);
  });
  it("selects visible results before pagination across 1000 hidden edges with bounded RTT", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const hiddenTemplate = await createRecord(f, f.targetModelKey, "hidden");
    const sourceModel = (await getRuntimeModel({ DB: f.db } as Bindings, f.sourceModelKey))!;
    const rows: D1PreparedStatement[] = [];
    for (let index = 0; index < 1060; index += 1) {
      const hidden = index < 1000;
      const id = `rec_sparse_${index}_${source.id.slice(4)}`;
      const template = hidden ? hiddenTemplate.id : source.id;
      rows.push(f.db.prepare(`INSERT INTO resource_records(id,space_id,model_key,model_version,version,
        created_by_type,created_by_entity_type,created_by_id,created_by_name_snapshot,created_at,updated_by_type,updated_by_entity_type,updated_by_id,updated_by_name_snapshot,updated_at)
        SELECT ?,space_id,model_key,model_version,version,created_by_type,created_by_entity_type,created_by_id,created_by_name_snapshot,created_at,
          updated_by_type,updated_by_entity_type,updated_by_id,updated_by_name_snapshot,updated_at FROM resource_records WHERE id=?`).bind(id, template));
      if (!hidden) rows.push(typedInsertStatement({ DB: f.db } as Bindings, sourceModel, id, f.spaceId, { name: `visible ${index}` }));
      rows.push(f.db.prepare(`INSERT INTO semantic_relations(id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(`rel_sparse_${index}_${source.id.slice(4)}`, f.spaceId, f.sourceModelKey, source.id, "relates_to",
          hidden ? f.targetModelKey : f.sourceModelKey, id, hidden ? "2026-10-13T00:00:00.000Z" : "2026-10-12T00:00:00.000Z"));
    }
    for (let start = 0; start < rows.length; start += 90) await f.db.batch(rows.slice(start, start + 90));
    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?").bind(f.clientId, f.targetModelKey).run();
    const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    const db = countingDatabase(f.db, cost);
    await getRuntimeModel({ DB: db } as Bindings, f.sourceModelKey); cost.roundTrips = 0; cost.rowsRead = 0; cost.sql = [];
    const path = `/api/v1/spaces/${f.spaceId}/semantic-relations?sourceModelKey=${f.sourceModelKey}&sourceRecordId=${source.id}&limit=50&hydrate=both`;
    const started = performance.now();
    const first = await request(f.publicKey, f.bearer, path, {}, { DB: db });
    const data = (await json(first)).data;
    expect(first.status).toBe(200); expect(data.items).toHaveLength(50);
    expect(data.items.every((edge: any) => edge.target.modelKey === f.sourceModelKey)).toBe(true);
    const cursor = JSON.parse(atob(data.nextCursor));
    expect(data.items.some((edge: any) => edge.id === cursor.id)).toBe(true);
    expect(cost.roundTrips).toBe(3);
    expect(cost.rowsRead).toBeLessThan(12000);
    console.log("SEMANTIC_RELATION_LOCAL_COST", JSON.stringify({ credential: "User JWT", items: 50,
      seededEdges: 1060, roundTrips: cost.roundTrips, rowsRead: cost.rowsRead, localMs: performance.now() - started }));
    const second = (await json(await request(f.publicKey, f.bearer, `${path}&cursor=${encodeURIComponent(data.nextCursor)}`, {}, { DB: db }))).data;
    expect(second.items).toHaveLength(10); expect(second.nextCursor).toBeNull();
    expect(new Set([...data.items, ...second.items].map((edge: any) => edge.id)).size).toBe(60);
    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?").bind(f.clientId, f.sourceModelKey).run();
    const denied = (await json(await request(f.publicKey, f.bearer, path, {}, { DB: db }))).data;
    expect(denied).toEqual({ items: [], nextCursor: null });
  });

  it("prevents a validated create from reintroducing an edge after endpoint deletion", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    let deleted = false;
    const db = countingDatabase(f.db, { roundTrips: 0, rowsRead: 0, sql: [] }, async (sql) => {
      if (!deleted && sql.some(text => text.includes("INSERT OR IGNORE INTO semantic_relations"))) {
        deleted = true;
        const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/${f.targetModelKey}/records/${target.id}`, {
          method: "DELETE", body: JSON.stringify({ version: target.version }),
        });
        expect(response.status).toBe(204);
      }
    });
    const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/semantic-relations`, { method: "POST", body: JSON.stringify({
      source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id }, predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
    }) }, { DB: db });
    expect(deleted).toBe(true); expect(response.status).toBe(404);
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relations WHERE space_id=?").bind(f.spaceId).first("count")).toBe(0);
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relation_changes WHERE space_id=?").bind(f.spaceId).first("count")).toBe(0);
  });
  it("atomically creates both endpoints and a standalone edge using forward clientRefs", async () => {
    const f = await fixture();
    const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, {
      method: "POST", body: JSON.stringify({ atomicConsistency: true, operations: [
        { operation: "relation_create", source: { kind: "record", modelKey: f.sourceModelKey, clientRef: "assessment" },
          predicate: "relates_to", target: { kind: "record", modelKey: f.targetModelKey, clientRef: "document" } },
        { operation: "create", modelKey: f.sourceModelKey, clientRef: "assessment", data: { name: "assessment" } },
        { operation: "create", modelKey: f.targetModelKey, clientRef: "document", data: { name: "document" } },
      ] }),
    });
    const result = await json(response);
    expect(result).not.toHaveProperty("error"); expect(response.status).toBe(200);
    const edge = await f.db.prepare("SELECT source_record_id,target_record_id FROM semantic_relations WHERE id=?")
      .bind(result.data.items[0].relationId).first<any>();
    expect(edge).toEqual({ source_record_id: result.data.items[1].recordId, target_record_id: result.data.items[2].recordId });
    const change = await f.db.prepare("SELECT change_set_id FROM semantic_relation_changes WHERE relation_id=?")
      .bind(result.data.items[0].relationId).first<any>();
    expect(change.change_set_id).toBe(result.data.changeSetId);
  });

  it("returns partial results and fails relation dependencies when a referenced create fails", async () => {
    const f = await fixture();
    const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, {
      method: "POST", body: JSON.stringify({ atomicConsistency: false, operations: [
        { operation: "create", modelKey: f.sourceModelKey, clientRef: "ok", data: { name: "ok" } },
        { operation: "create", modelKey: f.targetModelKey, clientRef: "bad", data: {} },
        { operation: "relation_create", source: { kind: "record", modelKey: f.sourceModelKey, clientRef: "ok" },
          predicate: "relates_to", target: { kind: "record", modelKey: f.targetModelKey, clientRef: "bad" } },
      ] }),
    });
    const result = (await json(response)).data;
    expect(response.status).toBe(200);
    expect(result.items.map((item: any) => item.status)).toEqual(["succeeded", "failed", "failed"]);
    expect(result.items[2].error.code).toBe("BATCH_DEPENDENCY_FAILED");
    const bulk = await f.db.prepare("SELECT succeeded_count,failed_count FROM resource_bulk_requests WHERE id=?").bind(result.bulkId).first<any>();
    expect(bulk).toEqual({ succeeded_count: 1, failed_count: 2 });
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relations WHERE space_id=?").bind(f.spaceId).first("count")).toBe(0);
  });

  it("creates and deletes relations in independent batches without deleting records", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const body = { atomicConsistency: false, operations: [{ operation: "relation_create",
      source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id }, predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } }] };
    const created = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", body: JSON.stringify(body) });
    const result = (await json(created)).data;
    expect(created.status).toBe(200); expect(result.items[0].status).toBe("succeeded");
    const deleted = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", body: JSON.stringify({
      operations: [{ operation: "relation_delete", relationId: result.items[0].relationId }], atomicConsistency: true,
    }) });
    expect(deleted.status).toBe(200);
    expect(await f.db.prepare("SELECT id FROM semantic_relations WHERE id=?").bind(result.items[0].relationId).first()).toBeNull();
    expect(await f.db.prepare("SELECT id FROM resource_records WHERE id=? AND deleted_at IS NULL").bind(source.id).first()).not.toBeNull();
  });

  it("rejects external atomicity explicitly instead of pretending to transact with a Provider", async () => {
    const f = await fixture();
    const response = await request(f.publicKey, f.bearer, `/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", body: JSON.stringify({
      atomicConsistency: true, operations: [{ operation: "relation_create", predicate: "relates_to",
        source: { kind: "record", modelKey: f.sourceModelKey, recordId: "rec_source" },
        target: { kind: "record", modelKey: "ext_notion", recordId: "rec_external" } }],
    }) });
    expect(response.status).toBe(400); expect((await json(response)).error.code).toBe("ATOMIC_CONSISTENCY_UNSUPPORTED");
  });

  it("keeps parallel duplicate creates idempotent with one Change", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const input = { source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
      predicate: "relates_to", target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id } };
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(f.publicKey, f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`, { method: "POST", body: JSON.stringify(input) })));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const ids = await Promise.all(responses.map(async response => (await json(response)).data.id));
    expect(new Set(ids).size).toBe(1);
    expect(await f.db.prepare("SELECT COUNT(*) count FROM semantic_relation_changes WHERE relation_id=?").bind(ids[0]).first("count")).toBe(1);
  });
  it("creates an idempotent cross-model edge and does not duplicate Change evidence", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const body = {
      source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
      predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
    };

    const first = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(first.status).toBe(200);
    const firstRelation = (await json(first)).data as { id: string };

    const retry = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(retry.status).toBe(200);
    expect((await json(retry)).data.id).toBe(firstRelation.id);

    const changeCount = await f.db.prepare(`SELECT COUNT(*) count FROM semantic_relation_changes
      WHERE relation_id=? AND operation='create'`).bind(firstRelation.id).first<{ count: number }>();
    expect(Number(changeCount?.count ?? 0)).toBe(1);
  });

  it("creates a new source Record and its Semantic Relations in one ChangeSet", async () => {
    const f = await fixture();
    const target = await createRecord(f, f.targetModelKey, "target");
    const response = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          operations: [{
            operation: "create",
            modelKey: f.sourceModelKey,
            data: { name: "atomic source" },
            semanticRelations: [{
              predicate: "relates_to",
              target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
            }],
          }],
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = (await json(response)).data;
    expect(result.items[0].semanticRelationIds).toHaveLength(1);

    const relationId = result.items[0].semanticRelationIds[0] as string;
    const relation = await f.db.prepare(`SELECT source_record_id,target_record_id FROM semantic_relations WHERE id=?`)
      .bind(relationId).first<{ source_record_id: string; target_record_id: string }>();
    expect(relation).toEqual({
      source_record_id: result.items[0].recordId,
      target_record_id: target.id,
    });
    const change = await f.db.prepare(`SELECT source_resource_change_id,change_set_id
      FROM semantic_relation_changes WHERE relation_id=? AND operation='create'`).bind(relationId)
      .first<{ source_resource_change_id: string; change_set_id: string }>();
    expect(change?.change_set_id).toBe(result.changeSetId);
    expect(change?.source_resource_change_id).toMatch(/^chg_/);
  });

  it("rolls back the new source Record when a Batch Semantic Relation target is missing", async () => {
    const f = await fixture();
    const before = await f.db.prepare(`SELECT COUNT(*) count FROM resource_records
      WHERE space_id=? AND model_key=?`).bind(f.spaceId, f.sourceModelKey).first<{ count: number }>();
    const response = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          operations: [{
            operation: "create",
            modelKey: f.sourceModelKey,
            data: { name: "must not commit" },
            semanticRelations: [{
              predicate: "relates_to",
              target: {
                kind: "record",
                modelKey: f.targetModelKey,
                recordId: `rec_missing_${crypto.randomUUID().replaceAll("-", "")}`,
              },
            }],
          }],
        }),
      },
    );
    expect(response.status).toBe(404);
    const after = await f.db.prepare(`SELECT COUNT(*) count FROM resource_records
      WHERE space_id=? AND model_key=?`).bind(f.spaceId, f.sourceModelKey).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("hides a relation when either endpoint is no longer exposed and atomically cleans it on endpoint delete", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const create = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      {
        method: "POST",
        body: JSON.stringify({
          source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
          predicate: "relates_to",
          target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
        }),
      },
    );
    const relationId = (await json(create)).data.id as string;

    await f.db.prepare(`DELETE FROM application_model_access WHERE application_id=? AND model_key=?`)
      .bind(f.clientId, f.targetModelKey).run();
    const hidden = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations/${relationId}`,
    );
    expect(hidden.status).toBe(404);

    await f.db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(f.clientId, f.targetModelKey, "write", "service", "svc_restore").run();
    const deleted = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/${f.targetModelKey}/records/${target.id}`,
      { method: "DELETE", body: JSON.stringify({ version: target.version }) },
    );
    expect(deleted.status).toBe(204);

    const edge = await f.db.prepare("SELECT id FROM semantic_relations WHERE id=?").bind(relationId).first();
    expect(edge).toBeNull();
    const cleanup = await f.db.prepare(`SELECT source_resource_change_id FROM semantic_relation_changes
      WHERE relation_id=? AND operation='endpoint_delete'`).bind(relationId)
      .first<{ source_resource_change_id: string }>();
    expect(cleanup?.source_resource_change_id).toMatch(/^chg_/);
  });
});

