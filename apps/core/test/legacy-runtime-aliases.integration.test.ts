import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { getPublishedModel, getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number };

const statementTargets = new WeakMap<object, D1PreparedStatement>();

function countedStatement(statement: D1PreparedStatement, counter: Counter): D1PreparedStatement {
  const proxy = new Proxy(statement as object, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => countedStatement(statement.bind(...values), counter);
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
      if (property === "prepare") return (query: string) => countedStatement(database.prepare(query), counter);
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

async function fixture() {
  const database = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_alias_${suffix}`;
  const spaceId = `spc_alias_${suffix}`;
  const personId = `per_alias_${suffix}`;
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Legacy Alias Test", userId, now, now, "UTC"),
    database.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_alias_${suffix}`, spaceId, userId, "owner", now, now),
    database.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "Alias Tester", now, now),
  ]);

  const taskModel = await getPublishedModel({ DB: database } as Bindings, "task");
  if (!taskModel) throw new Error("bootstrap Task model is missing");
  const actor: Principal = {
    type: "user",
    id: userId,
    clientId: "homemew-miniprogram",
    scopes: ["resources:read", "resources:write"],
    tokenId: `tok_alias_setup_${suffix}`,
  };
  const task = await createGenericResource({ DB: database } as Bindings, actor, spaceId, taskModel, {
    name: "Legacy alias task",
    assigneePersonIds: [personId],
  });

  const pair = await keys();
  const iat = Math.floor(Date.now() / 1000);
  const bearer = await sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "homemew-miniprogram",
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_alias_${suffix}`,
  }, pair.privateKey, "RS256");

  const counter: Counter = { roundTrips: 0 };
  const DB = countedDatabase(database, counter);
  const bindings = { DB, IDENTITY_PUBLIC_KEY: pair.publicKey, ENVIRONMENT: "test" };
  expect(await getRuntimeModel({ DB } as Bindings, "task")).not.toBeNull();
  counter.roundTrips = 0;

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    if (init.body) headers.set("content-type", "application/json");
    return createApp().request(`http://localhost${path}`, { ...init, headers }, bindings);
  }

  return { counter, request, spaceId, task };
}

async function withinBudget(counter: Counter, budget: number, operation: () => Promise<Response>, status = 200) {
  counter.roundTrips = 0;
  const response = await operation();
  expect(response.status).toBe(status);
  expect(counter.roundTrips).toBeLessThanOrEqual(budget);
  return response;
}

describe("pre-#200 Runtime compatibility aliases", () => {
  it("keeps the four fixed v1 aliases on the same bounded Generic Runtime path", async () => {
    const f = await fixture();

    for (const route of ["tasks", "events", "day-records", "wishes"]) {
      await withinBudget(f.counter, 5, () => f.request(`/api/v1/spaces/${f.spaceId}/${route}?limit=10`));
    }

    await withinBudget(f.counter, 4, () => f.request(`/api/v1/spaces/${f.spaceId}/tasks/${f.task.id}`));

    const patched = await withinBudget(
      f.counter,
      6,
      () => f.request(`/api/v1/spaces/${f.spaceId}/tasks/${f.task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ version: f.task.version, name: "Updated through v1 alias" }),
      }),
    );
    const patchedPayload = await patched.json<{ data: { version: number; modelKey: string } }>();
    expect(patchedPayload.data.modelKey).toBe("task");

    const completed = await withinBudget(
      f.counter,
      6,
      () => f.request(`/api/v1/spaces/${f.spaceId}/tasks/${f.task.id}/actions/complete`, {
        method: "POST",
        body: JSON.stringify({ version: patchedPayload.data.version }),
      }),
    );
    const completedPayload = await completed.json<{ data: { status: string; modelKey: string } }>();
    expect(completedPayload.data).toMatchObject({ modelKey: "task", status: "completed" });
  }, 20_000);
});
