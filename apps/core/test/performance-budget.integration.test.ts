import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { getPublishedModel, getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number; batchSizes: number[] };

const statementTargets = new WeakMap<object, D1PreparedStatement>();
// Fixture setup intentionally creates hundreds of records and an RSA key pair. The
// semantic performance gate below is the D1 round-trip/binding budget, not the
// hosted runner's total wall-clock time for setup plus assertions.
const PERFORMANCE_TEST_TIMEOUT_MS = 20_000;

function countedStatement(statement: D1PreparedStatement, counter: Counter): D1PreparedStatement {
  const proxy = new Proxy(statement as object, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => {
          counter.maxBindings = Math.max(counter.maxBindings, values.length);
          if (values.length > 100) throw new Error(`D1 bound parameter budget exceeded: ${values.length}`);
          return countedStatement(statement.bind(...values), counter);
        };
      }
      if (property === "first" || property === "all" || property === "run" || property === "raw") {
        return (...args: unknown[]) => {
          counter.roundTrips += 1;
          const fn = (statement as unknown as Record<PropertyKey, (...values: unknown[]) => unknown>)[property];
          return fn.apply(statement, args);
        };
      }
      return Reflect.get(target, property, statement);
    },
  }) as D1PreparedStatement;
  statementTargets.set(proxy as unknown as object, statement);
  return proxy;
}

function countedDatabase(database: D1Database, counter: Counter): D1Database {
  return new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => countedStatement(database.prepare(query), counter);
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counter.roundTrips += 1;
          counter.batchSizes.push(statements.length);
          return database.batch(statements.map((statement) => statementTargets.get(statement as unknown as object) ?? statement));
        };
      }
      if (property === "exec") {
        return (query: string) => {
          counter.roundTrips += 1;
          return database.exec(query);
        };
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;
}

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

async function accessToken(privateKey: string, userId: string, agentId?: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: agentId ?? userId,
    azp: "app_test_runtime",
    principal_type: "user",
    ...(agentId ? {
      principal_id: userId,
      actor_type: "agent",
      actor_id: agentId,
      purpose: "agent_execution",
    } : {}),
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function fixture() {
  const database = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_perf_${suffix}`;
  const spaceId = `spc_perf_${suffix}`;
  const personId = `per_perf_${suffix}`;
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Performance Budget", userId, now, now, "UTC"),
    database.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_perf_${suffix}`, spaceId, userId, "owner", now, now),
    database.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "Performance Tester", now, now),
  ]);

  const taskModel = await getPublishedModel({ DB: database } as Bindings, "task");
  const eventModel = await getPublishedModel({ DB: database } as Bindings, "event");
  if (!taskModel || !eventModel) throw new Error("bootstrap Task/Event models are missing");
  const actor: Principal = {
    type: "user",
    id: userId,
    clientId: "app_test_runtime",
    scopes: ["resources:read", "resources:write"],
    tokenId: `tok_setup_${suffix}`,
  };
  const records = [];
  for (let index = 0; index < 200; index += 1) {
    records.push(await createGenericResource({ DB: database } as Bindings, actor, spaceId, taskModel, {
      name: `Budget task ${String(index).padStart(3, "0")}`,
      assigneePersonIds: [],
    }));
  }
  const eventRecords = [];
  for (let index = 0; index < 200; index += 1) {
    const start = new Date(Date.UTC(2026, 7, 1, 0, index));
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    eventRecords.push(await createGenericResource({ DB: database } as Bindings, actor, spaceId, eventModel, {
      summary: `Budget event ${String(index).padStart(3, "0")}`,
      when: {
        kind: "instant",
        start: start.toISOString(),
        endExclusive: end.toISOString(),
      },
      attendeePersonIds: [],
      status: "active",
    }));
  }

  const keyPair = await keys();
  const bearer = await accessToken(keyPair.privateKey, userId);
  const counter: Counter = { roundTrips: 0, maxBindings: 0, batchSizes: [] };
  const DB = countedDatabase(database, counter);
  const bindings = { DB, IDENTITY_PUBLIC_KEY: keyPair.publicKey, ENVIRONMENT: "test" };

  // Prime the isolate-local Registry snapshot on the same wrapped binding, then
  // reset the counter so the assertions below measure the hot path only.
  expect(await getRuntimeModel({ DB } as Bindings, "task")).not.toBeNull();
  expect(await getRuntimeModel({ DB } as Bindings, "event")).not.toBeNull();
  counter.roundTrips = 0;
  counter.maxBindings = 0;
  counter.batchSizes = [];

  async function request(path: string, init: RequestInit = {}, bearerOverride = bearer) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearerOverride}`);
    if (init.body) headers.set("content-type", "application/json");
    return createApp().request(`http://localhost${path}`, { ...init, headers }, bindings);
  }

  return {
    DB,
    counter,
    request,
    privateKey: keyPair.privateKey,
    userId,
    spaceId,
    personId,
    records,
    eventRecords,
  };
}

async function measured(
  counter: Counter,
  operation: () => Promise<Response>,
  expectedStatus: number,
  budget: number,
): Promise<Response> {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
  counter.batchSizes = [];
  const response = await operation();
  expect(response.status).toBe(expectedStatus);
  expect(counter.roundTrips).toBeLessThanOrEqual(budget);
  expect(counter.maxBindings).toBeLessThanOrEqual(100);
  return response;
}

describe("Core D1 round-trip budgets", () => {
  it("keeps hot Registry lookup out of D1 and ordinary paths within round-trip and binding budgets", async () => {
    const f = await fixture();

    f.counter.roundTrips = 0;
    f.counter.maxBindings = 0;
    f.counter.batchSizes = [];
    expect(await getRuntimeModel({ DB: f.DB } as Bindings, "task")).not.toBeNull();
    expect(f.counter.roundTrips).toBe(0);

    const list = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/task/records?limit=200`),
      200,
      3,
    );
    const listPayload = await list.json<{ data: { items: Array<{ id: string; version: number }> } }>();
    expect(listPayload.data.items).toHaveLength(200);

    const calendar100 = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records/query`, {
        method: "POST",
        body: JSON.stringify({
          filter: {
            field: "when",
            op: "overlaps",
            value: {
              kind: "local_date_window",
              startDate: "2026-08-01",
              endDateExclusive: "2026-08-02",
              timezone: "UTC",
            },
          },
          context: { viewingTimezone: "UTC" },
          sort: [{ field: "when", direction: "asc" }],
          page: { limit: 100 },
        }),
      }),
      200,
      3,
    );
    const calendar100Payload = await calendar100.json<{ data: { items: Array<{ id: string; summary: string }> } }>();
    expect(calendar100Payload.data.items).toHaveLength(100);
    expect(calendar100Payload.data.items[0]?.summary).toBe("Budget event 000");

    const calendar200 = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records/query`, {
        method: "POST",
        body: JSON.stringify({
          context: { viewingTimezone: "UTC" },
          sort: [{ field: "when", direction: "asc" }],
          page: { limit: 200 },
        }),
      }),
      200,
      3,
    );
    const calendar200Payload = await calendar200.json<{ data: { items: Array<{ id: string; summary: string }> } }>();
    expect(calendar200Payload.data.items).toHaveLength(200);
    expect(calendar200Payload.data.items.at(-1)?.summary).toBe("Budget event 199");

    const target = f.records[0];
    await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/task/records/${target.id}`),
      200,
      2,
    );

    const eventTarget = f.eventRecords[0];
    await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records/${eventTarget.id}`),
      200,
      2,
    );

    const patchedEvent = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records/${eventTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ version: eventTarget.version, attendeePersonIds: [f.personId] }),
      }),
      200,
      4,
    );
    const patchedEventPayload = await patchedEvent.json<{ data: { attendeePersonIds: string[]; createdBy: { id: string }; updatedBy: { id: string } } }>();
    expect(patchedEventPayload.data.attendeePersonIds).toEqual([f.personId]);
    expect(patchedEventPayload.data.createdBy.id).toBe(f.userId);
    expect(patchedEventPayload.data.updatedBy.id).toBe(f.userId);

    const patched = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/task/records/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ version: target.version, name: "Budget task updated" }),
      }),
      200,
      3,
    );
    const patchedPayload = await patched.json<{ data: { version: number } }>();

    await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/task/records/${target.id}/actions/complete`, {
        method: "POST",
        body: JSON.stringify({ version: patchedPayload.data.version }),
      }),
      200,
      6,
    );

    await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/task/records`, {
        method: "POST",
        body: JSON.stringify({ name: "Budget created task", assigneePersonIds: [] }),
      }),
      201,
      2,
    );

    const batchCreate = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: Array.from({ length: 20 }, (_, index) => ({
            operation: "create",
            modelKey: "task",
            data: {
              name: `Budget batch task ${String(index).padStart(2, "0")}`,
              assigneePersonIds: [],
            },
          })),
        }),
      }),
      200,
      2,
    );
    const batchPayload = await batchCreate.json<{
      data: { changeSetId: string; items: Array<{ recordId: string }> };
    }>();
    expect(batchPayload.data.changeSetId).toMatch(/^cgs_/);
    expect(batchPayload.data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(1);

    const batchUpdate = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: f.records.slice(20, 40).map((record, index) => ({
            operation: "update",
            modelKey: "task",
            recordId: record.id,
            data: { name: `Budget batch update ${String(index).padStart(2, "0")}` },
          })),
        }),
      }),
      200,
      3,
    );
    expect((await batchUpdate.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(1);

    const batchDelete = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: f.records.slice(40, 60).map((record) => ({
            operation: "delete",
            modelKey: "task",
            recordId: record.id,
          })),
        }),
      }),
      200,
      3,
    );
    expect((await batchDelete.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(1);

    const mixedOperations = [
      ...Array.from({ length: 10 }, (_, index) => ({
        operation: "create",
        modelKey: "task",
        data: { name: `Budget mixed create ${index}`, assigneePersonIds: [] },
      })),
      ...f.records.slice(60, 65).map((record, index) => ({
        operation: "update",
        modelKey: "task",
        recordId: record.id,
        version: record.version,
        data: { name: `Budget mixed update ${index}` },
      })),
      ...f.records.slice(65, 70).map((record) => ({
        operation: "delete",
        modelKey: "task",
        recordId: record.id,
        version: record.version,
      })),
    ];
    const mixed = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({ operations: mixedOperations }),
      }),
      200,
      3,
    );
    expect((await mixed.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(1);

    const multiModel = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: [
            ...Array.from({ length: 10 }, (_, index) => ({
              operation: "create",
              modelKey: "task",
              data: { name: `Budget multi task ${index}`, assigneePersonIds: [] },
            })),
            ...Array.from({ length: 10 }, (_, index) => {
              const start = new Date(Date.UTC(2026, 8, 1, 0, index));
              return {
                operation: "create",
                modelKey: "event",
                data: {
                  summary: `Budget multi event ${index}`,
                  when: {
                    kind: "instant",
                    start: start.toISOString(),
                    endExclusive: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
                  },
                  attendeePersonIds: [],
                  status: "active",
                },
              };
            }),
          ],
        }),
      }),
      200,
      3,
    );
    expect((await multiModel.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(2);

    const relationBearing = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: Array.from({ length: 20 }, (_, index) => ({
            operation: "create",
            modelKey: "task",
            data: {
              name: `Budget relation task ${index}`,
              assigneePersonIds: [f.personId],
            },
          })),
        }),
      }),
      200,
      3,
    );
    expect((await relationBearing.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(1);

    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentBearer = await accessToken(f.privateKey, f.userId, agentId);
    const modelDelegationId = `dlg_perf_model_${crypto.randomUUID().replaceAll("-", "")}`;
    const delegatedNow = new Date().toISOString();
    await f.DB.batch([
      f.DB.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at
      ) VALUES(?,'user',?,'agent',?,?,?,'user',?,?)`).bind(
        modelDelegationId,
        f.userId,
        agentId,
        "app_test_runtime",
        f.spaceId,
        f.userId,
        delegatedNow,
      ),
      f.DB.prepare(`INSERT INTO delegation_scopes(
        delegation_id,target_type,target_id,target_model_key,max_access
      ) VALUES(?,'model','task','task','write')`).bind(modelDelegationId),
    ]);

    const delegatedModelBatch = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: Array.from({ length: 20 }, (_, index) => ({
            operation: "create",
            modelKey: "task",
            delegationId: modelDelegationId,
            data: { name: `Budget delegated model ${index}`, assigneePersonIds: [] },
          })),
        }),
      }, agentBearer),
      200,
      2,
    );
    expect((await delegatedModelBatch.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    expect(f.counter.batchSizes[0]).toBe(2);

    const singleUseIds = Array.from(
      { length: 20 },
      (_, index) => `dlg_perf_single_${index}_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    await f.DB.batch(singleUseIds.flatMap((delegationId) => [
      f.DB.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at,max_uses
      ) VALUES(?,'user',?,'agent',?,?,?,'user',?,?,1)`).bind(
        delegationId,
        f.userId,
        agentId,
        "app_test_runtime",
        f.spaceId,
        f.userId,
        delegatedNow,
      ),
      f.DB.prepare(`INSERT INTO delegation_scopes(
        delegation_id,target_type,target_id,target_model_key,max_access
      ) VALUES(?,'model','task','task','write')`).bind(delegationId),
    ]));

    const singleUseBatch = await measured(
      f.counter,
      () => f.request(`/api/v1/spaces/${f.spaceId}/models/batch`, {
        method: "POST",
        body: JSON.stringify({
          operations: singleUseIds.map((delegationId, index) => ({
            operation: "create",
            modelKey: "task",
            delegationId,
            data: { name: `Budget single use ${index}`, assigneePersonIds: [] },
          })),
        }),
      }, agentBearer),
      200,
      2,
    );
    expect((await singleUseBatch.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(20);
    // One base-Authority statement + one set-wise recursive Delegation-chain statement.
    expect(f.counter.batchSizes[0]).toBe(2);
    const consumed = await f.DB.prepare(`SELECT COUNT(*) count FROM delegations
      WHERE id IN (${singleUseIds.map(() => "?").join(",")}) AND consumed_at IS NOT NULL`)
      .bind(...singleUseIds)
      .first<{ count: number }>();
    expect(consumed?.count).toBe(20);

  }, PERFORMANCE_TEST_TIMEOUT_MS);
});
