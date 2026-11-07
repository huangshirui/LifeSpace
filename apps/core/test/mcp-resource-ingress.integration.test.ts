import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const db = (env as unknown as { DB: D1Database }).DB;
const origin = "https://core-staging.aisr.online";
const id = () => "mcp_" + crypto.randomUUID().replaceAll("-", "");
async function server(enabled = 1) {
  const serverId = id();
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO mcp_server_definitions(id,display_name,description,enabled,config_json,revision,created_by_user_id,updated_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)"
  ).bind(serverId, "Ingress test", "", enabled,
    JSON.stringify({ models: [{ modelKey: "task", operations: ["query"] }] }),
    "usr_synthetic", "usr_synthetic", now, now).run();
  return serverId;
}

describe("Core public MCP ingress / OAuth protected resource boundary", () => {
  it("privately validates enabled canonical resources for Identity without leaking configuration", async () => {
    const enabled = await server(), disabled = await server(0);
    const secret = "core-identity-trusted-test-secret";
    const endpoint = origin + "/internal/v1/oauth/mcp-resource/validate";
    const bindings = { DB: db, ENVIRONMENT: "staging", CORE_IDENTITY_SHARED_SECRET: secret,
      MCP_ADAPTER: { fetch: async () => Response.json({}) } };
    const send = (resource: string, proof?: string) => createApp().request(endpoint, {
      method: "POST", headers: {
        "content-type": "application/json",
        ...(proof ? { "x-lifespace-internal-secret": proof } : {}),
      }, body: JSON.stringify({ resource }),
    }, bindings);
    expect((await send(origin + "/mcp/" + enabled)).status).toBe(401);
    expect((await send(origin + "/mcp/" + enabled, "wrong")).status).toBe(401);
    const accepted = await send(origin + "/mcp/" + enabled, secret);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ data: {
      active: true, resource: origin + "/mcp/" + enabled, serverId: enabled,
    } });
    const noAdapter = await createApp().request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lifespace-internal-secret": secret,
      },
      body: JSON.stringify({ resource: origin + "/mcp/" + enabled }),
    }, { DB: db, ENVIRONMENT: "staging", CORE_IDENTITY_SHARED_SECRET: secret });
    expect(await noAdapter.json()).toEqual({ data: { active: false } });
    for (const value of [
      origin + "/mcp/" + disabled,
      origin + "/mcp/" + id(),
      origin + "/mcp/" + enabled + "?extra=1",
      "https://evil.example.test/mcp/" + enabled,
      origin + "/mcp",
    ]) {
      const denied = await send(value, secret);
      expect(await denied.json()).toEqual({ data: { active: false } });
    }
  });

  it("forwards multiple enabled Server paths and exact metadata to one private adapter, unchanged", async () => {
    const first = await server(), second = await server();
    const seen: Array<{ method: string; url: string; bearer: string | null }> = [];
    const bindings = {
      DB: db, ENVIRONMENT: "staging",
      MCP_ADAPTER: { fetch: async (request: Request) => {
        seen.push({
          method: request.method, url: request.url,
          bearer: request.headers.get("authorization"),
        });
        if (request.method === "GET") {
          return Response.json({ resource: origin + "/mcp/" + first }, {
            headers: { "cache-control": "public, max-age=300" },
          });
        }
        return Response.json({ error: "OAuth authorization required" }, {
          status: 401, headers: {
            "www-authenticate": 'Bearer resource_metadata="' + origin
              + '/.well-known/oauth-protected-resource/mcp/' + second + '"',
          },
        });
      } },
    };
    const metadata = await createApp().request(
      origin + "/.well-known/oauth-protected-resource/mcp/" + first,
      { method: "GET" }, bindings,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    const rpc = await createApp().request(origin + "/mcp/" + second, {
      method: "POST",
      headers: { authorization: "Bearer lsp_oat_test", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    }, bindings);
    expect(rpc.status).toBe(401);
    expect(rpc.headers.get("www-authenticate")).toContain("/mcp/" + second);
    expect(seen).toEqual([
      { method: "GET", url: origin + "/.well-known/oauth-protected-resource/mcp/" + first, bearer: null },
      { method: "POST", url: origin + "/mcp/" + second, bearer: "Bearer lsp_oat_test" },
    ]);
  });

  it("fails closed for disabled, unknown or malformed servers without contacting adapter", async () => {
    const disabled = await server(0);
    const valid = await server();
    let calls = 0;
    const bindings = {
      DB: db, ENVIRONMENT: "staging",
      MCP_ADAPTER: { fetch: async () => { calls++; return Response.json({ active: true }); } },
    };
    for (const suffix of [disabled, id(), "mcp_fake"]) {
      const res = await createApp().request(origin + "/mcp/" + suffix, { method: "POST" }, bindings);
      expect(res.status).toBe(404);
      const metadata = await createApp().request(
        origin + "/.well-known/oauth-protected-resource/mcp/" + suffix,
        { method: "GET" }, bindings,
      );
      expect(metadata.status).toBe(404);
    }
    expect((await createApp().request(origin + "/mcp", { method: "POST" }, bindings)).status).toBe(404);
    expect((await createApp().request(
      "https://evil.example.test/mcp/" + valid, { method: "POST" }, bindings,
    )).status).toBe(403);
    expect((await createApp().request(
      "https://core.aisr.online/mcp/" + valid, { method: "POST" }, bindings,
    )).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("denies missing or failed private Adapter binding, and rechecks disabled state", async () => {
    const serverId = await server();
    const url = origin + "/mcp/" + serverId;
    expect((await createApp().request(url, { method: "POST" }, {
      DB: db, ENVIRONMENT: "staging",
    })).status).toBe(503);
    expect((await createApp().request(url, { method: "POST" }, {
      DB: db, ENVIRONMENT: "staging",
      MCP_ADAPTER: { fetch: async () => { throw new Error("private adapter unavailable"); } },
    })).status).toBe(503);
    await db.prepare("UPDATE mcp_server_definitions SET enabled=0 WHERE id=?").bind(serverId).run();
    expect((await createApp().request(url, { method: "POST" }, {
      DB: db, ENVIRONMENT: "staging",
    })).status).toBe(404);
  });
});
