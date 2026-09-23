import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
import { getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number };
const statementTargets = new WeakMap<object, D1PreparedStatement>();
const MODEL_KEYS = ["task", "event", "day_record", "wish"] as const;
const TEST_TIMEOUT_MS = 15_000;

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

function reset(counter: Counter): void {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
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

async function token(privateKey: string, userId: string, clientId: string): Promise<string> {
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

async function seed(database: D1Database) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_inventory_perf_${suffix}`;
  const clientId = `app_inventory_perf_${suffix}`;
  const now = new Date().toISOString();
  const spaceIds: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (let index = 0; index < 32; index += 1) {
    const spaceId = `spc_inventory_perf_${index}_${suffix}`;
    spaceIds.push(spaceId);
    statements.push(
      database.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, `Inventory Perf ${index}`, userId, now, now, "UTC"),
      database.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_inventory_perf_${index}_${suffix}`, spaceId, userId, "owner", now, now),
      database.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_inventory_perf_${index}_${suffix}`, spaceId, userId, `Inventory Owner ${index}`, now, now),
    );
  }
  for (const modelKey of MODEL_KEYS) {
    statements.push(database.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "user", userId));
  }
  await database.batch(statements);
  return { userId, clientId, spaceIds };
}

describe("#165 M3-S2 compact inventory performance", () => {
  it("de-duplicates heavy model semantics without increasing aggregate D1 shape or ordinary Runtime tax", async () => {
    const database = (env as unknown as TestEnv).DB;
    const keyPair = await keys();
    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const DB = countedDatabase(database, counter);
    const bindings = { DB, IDENTITY_PUBLIC_KEY: keyPair.publicKey, ENVIRONMENT: "test" };

    expect(await getRuntimeModel(bindings as Bindings, "task")).not.toBeNull();
    reset(counter);

    const scenario = await seed(database);
    const bearer = await token(keyPair.privateKey, scenario.userId, scenario.clientId);
    async function request(path: string) {
      return createApp().request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }, bindings);
    }

    reset(counter);
    const full = await request("/api/v1/me/_discovery");
    expect(full.status).toBe(200);
    const fullText = await full.text();
    const fullTrips = counter.roundTrips;
    const fullBytes = new TextEncoder().encode(fullText).byteLength;
    const fullPayload = JSON.parse(fullText) as { data: { spaces: Array<{ models: unknown[] }> } };
    const fullModelDtos = fullPayload.data.spaces.reduce((sum, space) => sum + space.models.length, 0);
    expect(fullTrips).toBe(2);
    expect(fullModelDtos).toBe(32 * MODEL_KEYS.length);

    reset(counter);
    const inventory = await request("/api/v1/me/_discovery/inventory");
    expect(inventory.status).toBe(200);
    const inventoryText = await inventory.text();
    const inventoryTrips = counter.roundTrips;
    const inventoryBytes = new TextEncoder().encode(inventoryText).byteLength;
    const inventoryPayload = JSON.parse(inventoryText) as {
      data: { models: unknown[]; spaces: Array<{ models: unknown[] }> };
    };
    const inventoryEdges = inventoryPayload.data.spaces.reduce((sum, space) => sum + space.models.length, 0);

    expect(inventoryTrips).toBe(fullTrips);
    expect(inventoryTrips).toBe(2);
    expect(counter.maxBindings).toBeLessThanOrEqual(100);
    expect(inventoryPayload.data.models).toHaveLength(MODEL_KEYS.length);
    expect(inventoryPayload.data.spaces).toHaveLength(32);
    expect(inventoryEdges).toBe(32 * MODEL_KEYS.length);
    expect(inventoryBytes).toBeLessThan(fullBytes * 0.15);

    reset(counter);
    const before = await request(`/api/v1/spaces/${scenario.spaceIds[0]}/models/task/records?limit=10`);
    expect(before.status).toBe(200);
    const beforeTrips = counter.roundTrips;
    expect(beforeTrips).toBeLessThanOrEqual(5);

    reset(counter);
    const explicitInventory = await request("/api/v1/me/_discovery/inventory");
    expect(explicitInventory.status).toBe(200);
    expect(counter.roundTrips).toBe(2);

    reset(counter);
    const after = await request(`/api/v1/spaces/${scenario.spaceIds[0]}/models/task/records?limit=10`);
    expect(after.status).toBe(200);
    const afterTrips = counter.roundTrips;
    expect(afterTrips).toBe(beforeTrips);

    console.info(`M3S2_COMPACT_INVENTORY ${JSON.stringify({
      scenario: "32-spaces-x-4-models",
      full: { bytes: fullBytes, roundTrips: fullTrips, modelDtos: fullModelDtos },
      inventory: {
        bytes: inventoryBytes,
        roundTrips: inventoryTrips,
        staticModels: inventoryPayload.data.models.length,
        visibilityEdges: inventoryEdges,
        byteRatio: Number((inventoryBytes / fullBytes).toFixed(4)),
      },
      ordinaryListNoMandatoryInventoryTax: {
        beforeRoundTrips: beforeTrips,
        afterRoundTrips: afterTrips,
        deltaD1: afterTrips - beforeTrips,
        deltaHttp: 0,
      },
    })}`);
  }, TEST_TIMEOUT_MS);
});

