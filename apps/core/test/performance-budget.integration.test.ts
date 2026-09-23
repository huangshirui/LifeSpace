import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { getPublishedModel, getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number };

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

async function accessToken(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "homemew-miniprogram",
    principal_type: "user",
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
    database.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Performance Budget", userId, now, now, "UTC"),
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
    clientId: "homemew-miniprogram",
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
  const counter: Counter = { roundTrips: 0, maxBindings: 0 };
  const DB = countedDatabase(database, counter);
  const bindings = { DB, IDENTITY_PUBLIC_KEY: keyPair.publicKey, ENVIRONMENT: "test" };

  // Prime the isolate-local Registry snapshot on the same wrapped binding, then
  // reset the counter so the assertions below measure the hot path only.
  expect(await getRuntimeModel({ DB } as Bindings, "task")).not.toBeNull();
  counter.roundTrips = 0;
  counter.maxBindings = 0;

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    if (init.body) headers.set("content-type", "application/json");
    return createApp().request(`http://localhost${path}`, { ...init, headers }, bindings);
  }

  return { DB, counter, request, spaceId, personId, records, eventRecords };
}

async function measured(
  counter: Counter,
  operation: () => Promise<Response>,
  expectedStatus: number,
  budget: number,
): Promise<Response> {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
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
    expect(patchedEventPayload.data.createdBy.id).toBe(f.records[0].audit?.createdBy.id ?? f.records[0].id);
    expect(patchedEventPayload.data.updatedBy.id).toBeDefined();

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
  }, PERFORMANCE_TEST_TIMEOUT_MS);
});

