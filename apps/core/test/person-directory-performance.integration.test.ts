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

describe("Space Person Directory performance", () => {
  it("keeps 500-Person canonical and alternate-name lookup set-based with constant D1 round trips", async () => {
    const realDb = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_person_perf_${suffix}`;
    const clientId = `app_person_perf_${suffix}`;
    const spaceId = `spc_person_perf_${suffix}`;
    const timestamp = new Date().toISOString();
    const people = Array.from({ length: 500 }, (_, index) => ({
      id: `per_person_perf_${suffix}_${String(index).padStart(4, "0")}`,
      displayName: `Person ${String(index).padStart(4, "0")}`,
      alias: index % 25 === 0 ? `小天${String(index).padStart(3, "0")}` : `Alias ${String(index).padStart(4, "0")}`,
    }));

    await realDb.batch([
      realDb.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, "Person Performance", userId, timestamp, timestamp, "UTC"),
      realDb.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_person_perf_${suffix}`, spaceId, userId, "owner", timestamp, timestamp),
    ]);
    for (let offset = 0; offset < people.length; offset += 50) {
      const chunk = people.slice(offset, offset + 50);
      await realDb.batch(chunk.flatMap((person, index) => [
        realDb.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
          VALUES(?,?,?,?,?,?)`).bind(
          person.id,
          spaceId,
          offset === 0 && index === 0 ? userId : null,
          person.displayName,
          timestamp,
          timestamp,
        ),
        realDb.prepare(`INSERT INTO space_person_names(id,space_id,person_id,name,created_at,updated_at)
          VALUES(?,?,?,?,?,?)`).bind(
          `spn_person_perf_${suffix}_${offset + index}`,
          spaceId,
          person.id,
          person.alias,
          timestamp,
          timestamp,
        ),
      ]));
    }

    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const countedDb = countedDatabase(realDb, counter);
    const { privateKey, publicKey } = await keys();
    const token = await bearer(privateKey, userId, clientId);
    const app = createApp();

    const call = async (query: string) => {
      reset(counter);
      const response = await app.request(
        `http://localhost/api/v1/spaces/${spaceId}/people${query}`,
        { headers: { authorization: `Bearer ${token}` } },
        { DB: countedDb, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      return {
        bytes: new TextEncoder().encode(text).byteLength,
        roundTrips: counter.roundTrips,
        maxBindings: counter.maxBindings,
      };
    };

    const one = await call("?limit=1");
    const maxPage = await call("?limit=100");
    const canonical = await call("?q=Person%200499&limit=100");
    const shortChineseAlias = await call(`?q=${encodeURIComponent("小天")}&limit=100`);

    for (const result of [one, maxPage, canonical, shortChineseAlias]) {
      expect(result.roundTrips).toBe(2);
      expect(result.maxBindings).toBeLessThanOrEqual(8);
      expect(result.bytes).toBeLessThan(128 * 1024);
    }
    expect(one.roundTrips).toBe(maxPage.roundTrips);
    expect(maxPage.roundTrips).toBe(shortChineseAlias.roundTrips);

    console.log("PERSON_DIRECTORY_PERFORMANCE", JSON.stringify({
      environment: "Cloudflare Vitest local D1; wall time omitted as non-APAC diagnostic",
      directorySize: people.length,
      one,
      maxPage,
      canonical,
      shortChineseAlias,
      noPerPersonWaterfall: one.roundTrips === maxPage.roundTrips && maxPage.roundTrips === shortChineseAlias.roundTrips,
    }));
  }, 20_000);
});
