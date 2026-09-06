import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
import { getRuntimeModelByRoute } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number };
type KeyPair = { privateKey: string; publicKey: string };
type Scenario = {
  name: string;
  userId: string;
  clientId: string;
  spaceIds: string[];
  modelKeys: string[];
};
type Sample = { elapsedMs: number; bytes: number; roundTrips: number; modelDtos: number };

const statementTargets = new WeakMap<object, D1PreparedStatement>();
const CURRENT_MODEL_KEYS = ["task", "event", "day_record", "wish"] as const;
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

async function token(privateKey: string, userId: string, clientId: string, agentId?: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    ...(agentId ? { actor_type: "agent", actor_id: agentId, purpose: "delegated_agent" } : {}),
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function seedScenario(
  database: D1Database,
  spaceCount: number,
  modelKeys: readonly string[],
  label: string,
): Promise<Scenario> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_m0b_${label}_${suffix}`;
  const clientId = `m0b-${label}-${suffix}`;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const spaceIds: string[] = [];

  for (let index = 0; index < spaceCount; index += 1) {
    const spaceId = `spc_m0b_${label}_${index}_${suffix}`;
    spaceIds.push(spaceId);
    statements.push(
      database.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", `M0-B ${label} ${index}`, userId, now, now, "UTC"),
      database.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_m0b_${label}_${index}_${suffix}`, spaceId, userId, "owner", now, now),
      database.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_m0b_${label}_${index}_${suffix}`, spaceId, userId, `M0-B Owner ${index}`, now, now),
    );
  }

  for (const modelKey of modelKeys) {
    statements.push(database.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)
      ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind(clientId, modelKey, "write", "user", userId));
  }
  await database.batch(statements);
  return { name: label, userId, clientId, spaceIds, modelKeys: [...modelKeys] };
}

async function seedPeople(database: D1Database, spaceId: string, count: number, label: string): Promise<void> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index += 1) {
    statements.push(database.prepare(`INSERT INTO space_people(id,space_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?)`).bind(
      `per_m0b_target_${label}_${String(index).padStart(4, "0")}`,
      spaceId,
      `Target ${String(index).padStart(4, "0")}`,
      now,
      now,
    ));
  }
  await database.batch(statements);
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return Number((sorted[Math.max(0, index)] ?? 0).toFixed(3));
}

function reset(counter: Counter): void {
  counter.roundTrips = 0;
  counter.maxBindings = 0;
}

async function measuredRequest(
  request: (path: string, bearer: string, init?: RequestInit) => Promise<Response>,
  counter: Counter,
  path: string,
  bearer: string,
): Promise<Sample> {
  reset(counter);
  const startedAt = performance.now();
  const response = await request(path, bearer);
  const elapsedMs = performance.now() - startedAt;
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = JSON.parse(text) as { data: { spaces?: Array<{ models: unknown[] }>; models?: unknown[] } };
  const modelDtos = payload.data.spaces
    ? payload.data.spaces.reduce((sum, space) => sum + space.models.length, 0)
    : (payload.data.models?.length ?? 0);
  return {
    elapsedMs,
    bytes: new TextEncoder().encode(text).byteLength,
    roundTrips: counter.roundTrips,
    modelDtos,
  };
}

function summarize(samples: Sample[]) {
  return {
    samples: samples.length,
    p50Ms: percentile(samples.map((sample) => sample.elapsedMs), 0.5),
    p90Ms: percentile(samples.map((sample) => sample.elapsedMs), 0.9),
    bytes: samples[0]?.bytes ?? 0,
    roundTrips: samples[0]?.roundTrips ?? 0,
    modelDtos: samples[0]?.modelDtos ?? 0,
  };
}

describe("#165 M0-B Generic Consumer performance feasibility", () => {
  it("proves current projection paths are opt-in, structurally bounded in D1, and exposes S x M payload growth", async () => {
    const database = (env as unknown as TestEnv).DB;
    const keyPair = await keys();
    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const DB = countedDatabase(database, counter);
    const bindings = { DB, IDENTITY_PUBLIC_KEY: keyPair.publicKey, ENVIRONMENT: "test" };

    // Warm the stable Registry snapshot on the measured binding; all assertions below
    // then describe current-main hot-cache behavior rather than cold Registry loading.
    expect(await getRuntimeModelByRoute({ DB } as Bindings, "tasks")).not.toBeNull();
    reset(counter);

    async function request(path: string, bearer: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      if (init.body) headers.set("content-type", "application/json");
      return createApp().request(`http://localhost${path}`, { ...init, headers }, bindings);
    }

    async function rawRequest(path: string, bearer: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      if (init.body) headers.set("content-type", "application/json");
      return createApp().request(`http://localhost${path}`, { ...init, headers }, {
        DB: database,
        IDENTITY_PUBLIC_KEY: keyPair.publicKey,
        ENVIRONMENT: "test",
      });
    }

    const scenarios = [
      await seedScenario(database, 1, ["task"], "s1m1"),
      await seedScenario(database, 4, ["task", "event"], "s4m2"),
      await seedScenario(database, 8, CURRENT_MODEL_KEYS, "s8m4"),
      await seedScenario(database, 16, CURRENT_MODEL_KEYS, "s16m4"),
      await seedScenario(database, 32, CURRENT_MODEL_KEYS, "s32m4"),
    ];

    const discoveryMetrics: Record<string, ReturnType<typeof summarize>> = {};
    for (const scenario of scenarios) {
      const bearer = await token(keyPair.privateKey, scenario.userId, scenario.clientId);
      const samples: Sample[] = [];
      for (let run = 0; run < 5; run += 1) {
        samples.push(await measuredRequest(request, counter, "/api/v1/me/_discovery", bearer));
        expect(counter.roundTrips).toBe(1);
        expect(counter.maxBindings).toBeLessThanOrEqual(100);
      }
      const summary = summarize(samples);
      expect(summary.modelDtos).toBe(scenario.spaceIds.length * scenario.modelKeys.length);
      discoveryMetrics[scenario.name] = summary;
    }

    expect(discoveryMetrics.s4m2.bytes).toBeGreaterThan(discoveryMetrics.s1m1.bytes);
    expect(discoveryMetrics.s8m4.bytes).toBeGreaterThan(discoveryMetrics.s4m2.bytes);
    expect(discoveryMetrics.s16m4.bytes).toBeGreaterThan(discoveryMetrics.s8m4.bytes);
    expect(discoveryMetrics.s32m4.bytes).toBeGreaterThan(discoveryMetrics.s16m4.bytes);

    const fullScenario = scenarios[2]!;
    const fullBearer = await token(keyPair.privateKey, fullScenario.userId, fullScenario.clientId);
    const singleSpaceSamples: Sample[] = [];
    for (let run = 0; run < 5; run += 1) {
      singleSpaceSamples.push(await measuredRequest(
        request,
        counter,
        `/api/v1/spaces/${fullScenario.spaceIds[0]}/_discovery`,
        fullBearer,
      ));
      expect(counter.roundTrips).toBe(1);
      expect(counter.maxBindings).toBeLessThanOrEqual(100);
    }

    // Ordinary CRUD/query does not need Discovery to run. Compare the same hot list
    // path before and after an explicit Discovery call; neither path gains an extra
    // D1 round trip or HTTP dependency from Generic Consumer Readiness work.
    reset(counter);
    const beforeDiscovery = await request(`/api/v1/spaces/${fullScenario.spaceIds[0]}/tasks?limit=10`, fullBearer);
    expect(beforeDiscovery.status).toBe(200);
    const ordinaryBeforeTrips = counter.roundTrips;
    expect(ordinaryBeforeTrips).toBeLessThanOrEqual(5);

    await measuredRequest(
      request,
      counter,
      `/api/v1/spaces/${fullScenario.spaceIds[0]}/_discovery`,
      fullBearer,
    );

    reset(counter);
    const afterDiscovery = await request(`/api/v1/spaces/${fullScenario.spaceIds[0]}/tasks?limit=10`, fullBearer);
    expect(afterDiscovery.status).toBe(200);
    const ordinaryAfterTrips = counter.roundTrips;
    expect(ordinaryAfterTrips).toBe(ordinaryBeforeTrips);
    expect(ordinaryAfterTrips).toBeLessThanOrEqual(5);

    // Relation Target Lookup is page-bounded and its D1 round trips do not grow with
    // result count. This is the current implemented reference-selection primitive.
    await seedPeople(database, fullScenario.spaceIds[0]!, 250, crypto.randomUUID().slice(0, 8));
    reset(counter);
    const target1 = await request(
      `/api/v1/spaces/${fullScenario.spaceIds[0]}/_relation-targets/task/assigneePersonIds?limit=1`,
      fullBearer,
    );
    expect(target1.status).toBe(200);
    const target1Text = await target1.text();
    const target1Trips = counter.roundTrips;

    reset(counter);
    const target100 = await request(
      `/api/v1/spaces/${fullScenario.spaceIds[0]}/_relation-targets/task/assigneePersonIds?limit=100`,
      fullBearer,
    );
    expect(target100.status).toBe(200);
    const target100Text = await target100.text();
    const target100Payload = JSON.parse(target100Text) as { data: { items: unknown[]; nextCursor: string | null } };
    const target100Trips = counter.roundTrips;
    expect(target100Payload.data.items).toHaveLength(100);
    expect(target100Payload.data.nextCursor).not.toBeNull();
    expect(target100Trips).toBe(target1Trips);
    expect(target100Trips).toBeLessThanOrEqual(3);
    expect(counter.maxBindings).toBeLessThanOrEqual(100);

    // Delegated-Agent Discovery adds one authority statement inside the same D1 batch;
    // it must not add a second Worker->D1 round trip on the hot Registry path.
    const delegatedScenario = await seedScenario(database, 1, ["task", "event"], "agent");
    const directBearer = await token(keyPair.privateKey, delegatedScenario.userId, delegatedScenario.clientId);
    const agentId = `agt_m0b_${crypto.randomUUID().replaceAll("-", "")}`;
    const delegationResponse = await rawRequest(
      `/api/v1/spaces/${delegatedScenario.spaceIds[0]}/agent-delegations`,
      directBearer,
      {
        method: "POST",
        body: JSON.stringify({
          agentId,
          models: [
            { modelKey: "task", maxAccess: "read" },
            { modelKey: "event", maxAccess: "write" },
          ],
        }),
      },
    );
    expect(delegationResponse.status).toBe(201);
    const delegatedBearer = await token(
      keyPair.privateKey,
      delegatedScenario.userId,
      delegatedScenario.clientId,
      agentId,
    );
    const delegatedSamples: Sample[] = [];
    for (let run = 0; run < 5; run += 1) {
      delegatedSamples.push(await measuredRequest(request, counter, "/api/v1/me/_discovery", delegatedBearer));
      expect(counter.roundTrips).toBe(1);
    }

    const metrics = {
      environment: "Cloudflare Vitest local D1; wall time is diagnostic, not APAC acceptance latency",
      currentPublishedModelCount: CURRENT_MODEL_KEYS.length,
      meDiscovery: discoveryMetrics,
      singleSpaceDiscovery: summarize(singleSpaceSamples),
      relationTargetLookup: {
        limit1: { bytes: new TextEncoder().encode(target1Text).byteLength, roundTrips: target1Trips },
        limit100: { bytes: new TextEncoder().encode(target100Text).byteLength, roundTrips: target100Trips },
      },
      delegatedAgentMeDiscovery: summarize(delegatedSamples),
      ordinaryListNoMandatoryProjectionTax: {
        beforeDiscoveryRoundTrips: ordinaryBeforeTrips,
        afterDiscoveryRoundTrips: ordinaryAfterTrips,
        deltaD1: ordinaryAfterTrips - ordinaryBeforeTrips,
        deltaHttp: 0,
      },
    };
    console.info(`M0B_PERFORMANCE_FEASIBILITY ${JSON.stringify(metrics)}`);
  }, PERFORMANCE_TEST_TIMEOUT_MS);
});
