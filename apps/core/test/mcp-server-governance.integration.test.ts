import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/g)?.join("\n") ?? "";
  return "-----BEGIN " + label + "-----\n" + base64 + "\n-----END " + label + "-----";
}
async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}
async function token(privateKey: string, type: "user" | "service",
  clientId: string, scopes: string[], proof = false) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity", aud: ["lifespace-core", "lifespace-identity"],
    sub: type + "_" + crypto.randomUUID().replaceAll("-", ""),
    azp: clientId, principal_type: type, scope: scopes.join(" "),
    ...(proof ? { purpose: "platform_admin_actor" } : {}),
    iat, exp: iat + (proof ? 300 : 900), jti: "tok_" + crypto.randomUUID(),
  }, privateKey, "RS256");
}
async function setup() {
  const pair = await keys();
  const app = "app_console_" + crypto.randomUUID().replaceAll("-", "");
  const executor = await token(pair.privateKey, "service", app, ["models:manage", "audit:read"]);
  const actor = await token(pair.privateKey, "user", app, ["platform:admin"], true);
  async function call(method: string, url: string, data?: unknown,
    actorOverride = actor, executorOverride = executor) {
    return createApp().request("http://localhost" + url, {
      method,
      headers: {
        authorization: "Bearer " + executorOverride,
        ...(actorOverride ? { "x-lifespace-actor-token": actorOverride } : {}),
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, { DB: (env as unknown as TestEnv).DB, IDENTITY_PUBLIC_KEY: pair.publicKey, ENVIRONMENT: "test" });
  }
  return { call, pair, app, actor, executor };
}
const root = "/api/v1/platform-admin/mcp-servers";
const task = { models: [{ modelKey: "task", operations: ["query", "get", "action:complete"] }] };
const person = { models: [], resources: [{
  resourceKey: "person_directory", operations: ["list", "get", "create", "update", "delete"],
}] };

describe("MCP Server direct configuration lifecycle", () => {
  it("requires Platform Admin human proof and scoped executor", async () => {
    const { call, pair, app } = await setup();
    expect((await call("GET", root, undefined, "")).status).toBe(401);
    const unrelated = await token(pair.privateKey, "user", "app_other", ["platform:admin"], true);
    expect((await call("GET", root, undefined, unrelated)).status).toBe(403);
    const unscoped = await token(pair.privateKey, "service", app, ["spaces:manage"]);
    expect((await call("GET", root, undefined, undefined, unscoped)).status).toBe(403);
  });

  it("creates enabled directly, saves new config and verifies current authority and audit", async () => {
    const { call } = await setup();
    const created = await call("POST", root, { name: "Tasks", configuration: task });
    expect(created.status).toBe(201);
    const first = (await created.json() as any).data;
    const id: string = first.id;
    expect(id).toMatch(/^mcp_[a-f0-9]{32}$/u);
    expect(first).toMatchObject({
      id, path: "/mcp/" + id, enabled: true, revision: 1, configuration: {
        models: [{ modelKey: "task", operations: ["action:complete", "get", "query"] }],
      },
    });
    expect(first).not.toHaveProperty("draft");
    expect(first).not.toHaveProperty("publishedRevision");
    expect((await call("POST", root, { name: "Tasks", configuration: task })).status).toBe(201);
    expect((await call("GET", root + "/tasks")).status).toBe(404);
    expect((await call("GET", root + "/" + id + "/revisions")).status).toBe(404);
    expect((await call("POST", root + "/" + id + "/publish", {})).status).toBe(404);

    const changed = await call("PATCH", root + "/" + id, {
      expectedRevision: 1, name: "Daily tasks",
      configuration: { models: [{ modelKey: "task", operations: ["get", "query"] }] },
    });
    expect(changed.status).toBe(200);
    const second = (await changed.json() as any).data;
    expect(second).toMatchObject({ enabled: true, revision: 2, name: "Daily tasks" });
    expect(second.configuration.models[0].operations).toEqual(["get", "query"]);
    expect((await call("PATCH", root + "/" + id, {
      expectedRevision: 1, name: "Stale",
    })).status).toBe(409);
    const row = await (env as unknown as TestEnv).DB.prepare(
      "SELECT revision,enabled,config_json FROM mcp_server_definitions WHERE id=?"
    ).bind(id).first<{ revision: number; enabled: number; config_json: string }>();
    expect(row?.revision).toBe(2);
    expect(row?.enabled).toBe(1);
    expect(JSON.parse(row!.config_json).models[0].operations).toEqual(["get", "query"]);
    const audit = (await (await call("GET", "/api/v1/platform-admin/audit?limit=100")).json() as any).data;
    expect(audit.some((entry: any) => entry.operation === "mcp_server.create" && entry.targetId === id)).toBe(true);
    expect(audit.some((entry: any) => entry.operation === "mcp_server.update" && entry.targetId === id)).toBe(true);
  });

  it("requires separate confirmation for enable/disable; disabling does not erase configuration", async () => {
    const { call } = await setup();
    const created = await call("POST", root, { name: "People", configuration: person });
    expect(created.status).toBe(201);
    const first = (await created.json() as any).data;
    const id: string = first.id;
    expect(first.configuration.resources[0]).toMatchObject({
      resourceKey: "person_directory",
      operations: ["create", "delete", "get", "list", "update"],
    });
    expect((await call("PATCH", root + "/" + id, { expectedRevision: 1, enabled: false })).status).toBe(422);
    expect((await call("PATCH", root + "/" + id, {
      expectedRevision: 1, enabled: false, confirmId: "mcp_" + "0".repeat(32),
    })).status).toBe(422);
    expect((await call("PATCH", root + "/" + id, {
      expectedRevision: 1, enabled: false, confirmId: id, configuration: task,
    })).status).toBe(400);
    const disabled = await call("PATCH", root + "/" + id, {
      expectedRevision: 1, enabled: false, confirmId: id,
    });
    expect(disabled.status).toBe(200);
    const after = (await disabled.json() as any).data;
    expect(after).toMatchObject({ enabled: false, revision: 2 });
    expect(after.configuration.resources[0].resourceKey).toBe("person_directory");
    expect((await call("PATCH", root + "/" + id, {
      expectedRevision: 2, enabled: false, confirmId: id,
    })).status).toBe(409);
    const enabled = await call("PATCH", root + "/" + id, {
      expectedRevision: 2, enabled: true, confirmId: id,
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json() as any).data).toMatchObject({ enabled: true, revision: 3 });
  });

  it("can always disable a Server if its formerly published Model becomes unavailable", async () => {
    const { call } = await setup();
    const created = await call("POST", root, { name: "Retiring model", configuration: task });
    expect(created.status).toBe(201);
    const id = (await created.json() as any).data.id as string;
    const db = (env as unknown as TestEnv).DB;
    // Simulates a previously valid Model being retired after Server creation.
    await db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
      .bind(JSON.stringify({ models: [{ modelKey: "no_longer_published", operations: ["get"] }] }), id).run();
    const disabled = await call("PATCH", root + "/" + id, {
      expectedRevision: 1, enabled: false, confirmId: id,
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json() as any).data.enabled).toBe(false);
    const rejected = await call("PATCH", root + "/" + id, {
      expectedRevision: 2, enabled: true, confirmId: id,
    });
    expect(rejected.status).toBe(422);
  });

  it("supports Person-only and mixed Model + Kernel resource, rejects fake person Model", async () => {
    const { call } = await setup();
    const mixed = { models: [{ modelKey: "task", operations: ["query"] }],
      resources: [{ resourceKey: "person_directory", operations: ["list", "get"] }] };
    const saved = await call("POST", root, { name: "Family helper", configuration: mixed });
    expect(saved.status).toBe(201);
    const value = (await saved.json() as any).data;
    expect(value.configuration.models).toHaveLength(1);
    expect(value.configuration.resources).toEqual([{ resourceKey: "person_directory", operations: ["get", "list"] }]);
    for (const invalid of [
      { models: [], resources: [{ resourceKey: "person", operations: ["get"] }] },
      { models: [], resources: [{ resourceKey: "person_directory", operations: ["query"] }] },
      { models: [], resources: [{ resourceKey: "person_directory", operations: ["list", "list"] }] },
      { models: [], resources: [{ resourceKey: "person_directory", operations: [] }] },
      { models: [], resources: [{ resourceKey: "person_directory", operations: ["list"] },
        { resourceKey: "person_directory", operations: ["get"] }] },
      { models: [] },
    ]) {
      expect((await call("POST", root, { name: "Invalid resources", configuration: invalid })).status).toBe(422);
    }
    expect((await call("POST", root, { name: "Fake person",
      configuration: { models: [{ modelKey: "person", operations: ["get"] }] },
    })).status).toBe(422);
    expect((await call("POST", root, { name: "Invalid capability",
      configuration: { models: [{ modelKey: "task", operations: ["action:not_real"] }] },
    })).status).toBe(422);
    expect((await call("POST", root, { name: "Old empty draft" })).status).toBe(422);
  });

  it("uses schema 78 simple table without publication version history", async () => {
    const db = (env as unknown as TestEnv).DB;
    const columns = await db.prepare("PRAGMA table_info(mcp_server_definitions)").all<{ name: string }>();
    const names = columns.results.map((x) => x.name);
    for (const name of ["id", "enabled", "config_json", "revision"]) expect(names).toContain(name);
    for (const name of ["draft_json", "published_revision", "server_key"]) expect(names).not.toContain(name);
    const publications = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_server_publications'"
    ).first();
    expect(publications).toBeNull();
    const schema = await db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'")
      .first<{ value: string }>();
    expect(schema?.value).toBe("78");
  });
});
