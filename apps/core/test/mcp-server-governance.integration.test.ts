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
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}
async function token(privateKey: string, type: "user" | "service", clientId: string, scopes: string[], proof = false) {
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
  async function call(method: string, path: string, data?: unknown, actorOverride = actor, executorOverride = executor) {
    const response = await createApp().request("http://localhost" + path, {
      method,
      headers: {
        authorization: "Bearer " + executorOverride,
        ...(actorOverride ? { "x-lifespace-actor-token": actorOverride } : {}),
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, { DB: (env as unknown as TestEnv).DB, IDENTITY_PUBLIC_KEY: pair.publicKey, ENVIRONMENT: "test" });
    return response;
  }
  return { call, pair, app, executor, actor };
}

describe("MCP domain Server governance", () => {
  it("enforces platform-admin human proof and controlled executor, not ordinary user/Space authority", async () => {
    const { call, pair, app } = await setup();
    const missing = await call("GET", "/api/v1/platform-admin/mcp-servers", undefined, "");
    expect(missing.status).toBe(401);
    const unrelated = await token(pair.privateKey, "user", "app_unrelated", ["platform:admin"], true);
    expect((await call("GET", "/api/v1/platform-admin/mcp-servers", undefined, unrelated)).status).toBe(403);
    const withoutScope = await token(pair.privateKey, "service", app, ["spaces:manage"]);
    expect((await call("GET", "/api/v1/platform-admin/mcp-servers", undefined, undefined, withoutScope)).status).toBe(403);
  });

  it("supports draft, model/action validation, immutable publication versions, withdraw and audit", async () => {
    const { call } = await setup();
    const root = "/api/v1/platform-admin/mcp-servers";
    const created = await call("POST", root, { name: "Everyday tasks" });
    expect(created.status).toBe(201);
    const first = (await created.json() as any).data;
    const serverId: string = first.id;
    expect(serverId).toMatch(/^mcp_[a-f0-9]{32}$/u);
    expect(first).toMatchObject({ id: serverId, path: "/mcp/" + serverId, status: "draft", draftRevision: 1, publishedRevision: null });
    expect(first).not.toHaveProperty("key");
    const sameName = await call("POST", root, { name: "Everyday tasks" });
    expect(sameName.status).toBe(201);
    expect((await sameName.json() as any).data.id).not.toBe(serverId);
    expect((await call("POST", root, { name: "Not permitted", key: "tasks" })).status).toBe(400);
    expect((await call("POST", root, { name: "Not permitted", id: serverId })).status).toBe(400);
    expect((await call("GET", root + "/tasks")).status).toBe(404);
    expect((await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 1, confirmId: serverId })).status).toBe(422);

    const draft = { models: [{ modelKey: "task", operations: ["query", "get", "action:complete"] }, { modelKey: "event", operations: ["query"] }] };
    const updated = await call("PATCH", root + "/" + serverId, { draft, expectedDraftRevision: 1, description: "Tasks and events" });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data.draftRevision).toBe(2);
    expect((await call("PATCH", root + "/" + serverId, { draft, expectedDraftRevision: 1 })).status).toBe(409);
    expect((await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 2, confirmId: "another-key" })).status).toBe(422);

    const published = await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 2, confirmId: serverId });
    expect(published.status).toBe(200);
    const firstPub = (await published.json() as any).data;
    expect(firstPub).toMatchObject({ status: "published", publishedRevision: 1 });
    expect(firstPub.published.manifest.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelKey: "task", operations: ["action:complete", "get", "query"], schemaHash: expect.any(String) }),
      expect.objectContaining({ modelKey: "event", operations: ["query"] }),
    ]));
    expect(firstPub.published.manifestHash).toHaveLength(64);
    expect((await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 2, confirmId: serverId })).status).toBe(409);

    const revised = await call("PATCH", root + "/" + serverId, {
      draft: { models: [{ modelKey: "task", operations: ["get", "query"] }] },
      expectedDraftRevision: 2,
    });
    expect(revised.status).toBe(200);
    const detail = (await (await call("GET", root + "/" + serverId)).json() as any).data;
    expect(detail.status).toBe("published");
    expect(detail.publishedRevision).toBe(1);
    expect(detail.published.manifest.models).toHaveLength(2);

    const version2 = await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 3, confirmId: serverId });
    expect(version2.status).toBe(200);
    expect((await version2.json() as any).data.publishedRevision).toBe(2);
    const history = (await (await call("GET", root + "/" + serverId + "/revisions")).json() as any).data;
    expect(history.map((item: any) => item.revision)).toEqual([2, 1]);
    expect(history[1].manifest.models).toHaveLength(2);
    const db = (env as unknown as TestEnv).DB;
    const source = await db.prepare("SELECT id,server_key FROM mcp_server_definitions WHERE id=?").bind(serverId).first<{id: string;server_key: string}>();
    expect(source?.server_key).toBe(serverId);
    expect(firstPub.published.manifest).toMatchObject({ serverId, path: "/mcp/" + serverId });
    await expect(db.prepare("UPDATE mcp_server_publications SET manifest_hash='tamper' WHERE server_id=?").bind(source!.id).run()).rejects.toThrow();

    const withdrawn = await call("POST", root + "/" + serverId + "/withdraw", { confirmId: serverId });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json() as any).data.status).toBe("withdrawn");
    expect((await call("POST", root + "/" + serverId + "/withdraw", { confirmId: serverId })).status).toBe(409);
    const entries = (await (await call("GET", "/api/v1/platform-admin/audit?limit=100")).json() as any).data;
    expect(entries.some((entry: any) => entry.operation === "mcp_server.publish" && entry.targetId === source!.id)).toBe(true);
    expect(entries.some((entry: any) => entry.operation === "mcp_server.withdraw" && entry.targetId === source!.id)).toBe(true);
  });

  it("rejects unpublished models, unavailable actions and invalid draft input", async () => {
    const { call } = await setup();
    const root = "/api/v1/platform-admin/mcp-servers";
    expect((await call("POST", root, { name: "" })).status).toBe(422);
    expect((await call("POST", root, { key: "INVALID SPACE", name: "Broken" })).status).toBe(400);
    const created = await call("POST", root, { name: "Validation" });
    expect(created.status).toBe(201);
    const serverId = (await created.json() as any).data.id as string;
    expect((await call("PATCH", root + "/" + serverId, { expectedDraftRevision: 1, draft: { models: [
      { modelKey: "task", operations: ["query", "query"] },
    ] } })).status).toBe(422);
    expect((await call("PATCH", root + "/" + serverId, { expectedDraftRevision: 1, draft: { models: [
      { modelKey: "model_that_does_not_exist", operations: ["query"] },
    ] } })).status).toBe(200);
    expect((await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 2, confirmId: serverId })).status).toBe(422);
    expect((await call("PATCH", root + "/" + serverId, { expectedDraftRevision: 2, draft: { models: [
      { modelKey: "task", operations: ["action:not_real"] },
    ] } })).status).toBe(200);
    expect((await call("POST", root + "/" + serverId + "/publish", { expectedDraftRevision: 3, confirmId: serverId })).status).toBe(422);
  });
});
