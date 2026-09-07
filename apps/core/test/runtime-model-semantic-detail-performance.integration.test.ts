import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
import { getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number };

const statementTargets = new WeakMap<object, D1PreparedStatement>();

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
          const fn = (statement as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[property];
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

function reset(counter: Counter) {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
}

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keyPair() {
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

async function bearer(privateKey: string, userId: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "resources:read",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

describe("Progressive model semantic detail performance", () => {
  it("uses one hot authority round trip and adds no mandatory projection tax to ordinary CRUD", async () => {
    const realDb = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_s2_${suffix}`;
    const clientId = `app_s2_${suffix}`;
    const spaceId = `spc_s2_${suffix}`;
    const now = new Date().toISOString();

    await realDb.batch([
      realDb.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "S2 Performance", userId, now, now, "UTC"),
      realDb.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_s2_${suffix}`, spaceId, userId, "owner", now, now),
      realDb.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_s2_${suffix}`, spaceId, userId, "S2 Owner", now, now),
      realDb.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
        VALUES(?,?,?,?,?)`).bind(clientId, "task", "read", "user", userId),
    ]);

    const model = await getRuntimeModel({ DB: realDb } as Bindings, "task");
    expect(model?.key).toBe("task");

    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const countedDb = countedDatabase(realDb, counter);
    const { privateKey, publicKey } = await keyPair();
    const accessToken = await bearer(privateKey, userId, clientId);
    const app = createApp();
    const call = (path: string) => app.request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, {
      DB: countedDb,
      IDENTITY_PUBLIC_KEY: publicKey,
      ENVIRONMENT: "test",
    });

    const warm = await call(`/api/v1/spaces/${spaceId}/tasks`);
    expect(warm.status).toBe(200);

    reset(counter);
    const before = await call(`/api/v1/spaces/${spaceId}/tasks`);
    expect(before.status).toBe(200);
    const ordinaryBefore = counter.roundTrips;

    reset(counter);
    const detail = await call(`/api/v1/spaces/${spaceId}/_discovery/models/task`);
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    const detailBytes = new TextEncoder().encode(detailText).byteLength;
    const detailRoundTrips = counter.roundTrips;
    const detailMaxBindings = counter.maxBindings;

    reset(counter);
    const after = await call(`/api/v1/spaces/${spaceId}/tasks`);
    expect(after.status).toBe(200);
    const ordinaryAfter = counter.roundTrips;

    expect(detailRoundTrips).toBe(1);
    expect(detailMaxBindings).toBeLessThanOrEqual(100);
    expect(detailBytes).toBeLessThan(64 * 1024);
    expect(ordinaryBefore).toBe(2);
    expect(ordinaryAfter).toBe(ordinaryBefore);

    console.log("M3S2_MODEL_DETAIL_PERFORMANCE", JSON.stringify({
      environment: "Cloudflare Vitest local D1; wall time omitted as non-APAC diagnostic",
      modelKey: "task",
      hotDetail: { bytes: detailBytes, roundTrips: detailRoundTrips, maxBindings: detailMaxBindings },
      ordinaryListNoMandatoryProjectionTax: {
        beforeDetailRoundTrips: ordinaryBefore,
        afterDetailRoundTrips: ordinaryAfter,
        deltaD1: ordinaryAfter - ordinaryBefore,
        deltaHttp: 0,
      },
    }));
  }, 20_000);
});
