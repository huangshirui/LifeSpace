import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

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

function reset(counter: Counter) {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
}

describe("Batch Reference Resolution performance", () => {
  it("keeps hot 1, small and max=50 Person hydration set-based with bounded bindings", async () => {
    const realDb = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_ref_perf_${suffix}`;
    const clientId = `app_ref_perf_${suffix}`;
    const spaceId = `spc_ref_perf_${suffix}`;
    const now = new Date().toISOString();
    const personIds = Array.from({ length: 50 }, (_, index) => `per_ref_perf_${suffix}_${index}`);

    const setup = [
      realDb.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Reference Resolution Performance", userId, now, now, "UTC"),
      realDb.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_ref_perf_${suffix}`, spaceId, userId, "owner", now, now),
      realDb.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
        VALUES(?,?,?,?,?)`).bind(clientId, "task", "read", "user", userId),
      ...personIds.map((id, index) => realDb.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(id, spaceId, index === 0 ? userId : null, `Reference Person ${String(index).padStart(2, "0")}`, now, now)),
    ];
    await realDb.batch(setup);

    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const countedDb = countedDatabase(realDb, counter);
    const { privateKey, publicKey } = await keys();
    const accessToken = await bearer(privateKey, userId, clientId);
    const app = createApp();
    const url = `http://localhost/api/v1/spaces/${spaceId}/_reference-resolutions/task/assigneePersonIds`;
    const post = (ids: string[]) => app.request(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      },
      { DB: countedDb, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" },
    );

    // Exclude the one-time Runtime Model snapshot warm-up. D1's acceptance target is the
    // hot request shape after the isolate has compiled its stable Registry descriptor.
    const warm = await post(personIds.slice(0, 1));
    expect(warm.status).toBe(200);

    const call = async (ids: string[]) => {
      reset(counter);
      const response = await post(ids);
      expect(response.status).toBe(200);
      const text = await response.text();
      return {
        bytes: new TextEncoder().encode(text).byteLength,
        roundTrips: counter.roundTrips,
        maxBindings: counter.maxBindings,
      };
    };

    const one = await call(personIds.slice(0, 1));
    const small = await call([...personIds.slice(0, 8), `per_ref_perf_missing_${suffix}`]);
    const max = await call(personIds);

    expect(one.roundTrips).toBe(small.roundTrips);
    expect(small.roundTrips).toBe(max.roundTrips);
    expect(max.roundTrips).toBeLessThanOrEqual(3);
    expect(max.maxBindings).toBe(51);
    expect(one.maxBindings).toBeLessThanOrEqual(max.maxBindings);
    expect(max.bytes).toBeLessThan(16 * 1024);

    console.log("M3D1_REFERENCE_RESOLUTION_PERFORMANCE", JSON.stringify({
      environment: "Cloudflare Vitest local D1; wall time omitted as non-APAC diagnostic",
      maxIds: 50,
      warmupExcluded: true,
      one,
      small,
      max,
      noPerIdWaterfall: one.roundTrips === small.roundTrips && small.roundTrips === max.roundTrips,
    }));
  }, 20_000);
});
