import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const SERVER_ID = /^mcp_[a-f0-9]{32}$/u;
type ServerState = { enabled: number };

export function expectedOrigin(env: Bindings): string | null {
  if (env.ENVIRONMENT === "production") return "https://core.aisr.online";
  if (env.ENVIRONMENT === "staging") return "https://core-staging.aisr.online";
  // Local/test environments must explicitly opt in; never trust Host alone.
  if (env.MCP_PUBLIC_ORIGIN && /^https:\/\/[a-z0-9.-]+$/u.test(env.MCP_PUBLIC_ORIGIN)) {
    return env.MCP_PUBLIC_ORIGIN;
  }
  return null;
}

async function forward(c: Context<AppEnv>, serverId: string) {
  if (!SERVER_ID.test(serverId)) return c.json({ error: "MCP Server not found" }, 404);
  const origin = expectedOrigin(c.env);
  // Public Core must be the trusted, exact resource origin; a forged Host,
  // alternate Worker preview URL or other authority must not mint a resource.
  if (!origin || new URL(c.req.url).origin !== origin) {
    return c.json({ error: "MCP resource origin unavailable" }, 403);
  }
  const row = await c.env.DB.prepare(
    "SELECT enabled FROM mcp_server_definitions WHERE id=?"
  ).bind(serverId).first<ServerState>();
  if (!row || row.enabled !== 1) {
    return c.json({ error: "MCP Server not found" }, 404, { "cache-control": "no-store" });
  }
  // The independently deployed Adapter is intentionally optional until
  // owner-reviewed staging convergence; never turn missing binding into an
  // unauthenticated Core query fallback or expose the Platform Admin API.
  const adapter = c.env.MCP_ADAPTER;
  if (!adapter) return c.json({ error: "MCP resource unavailable" }, 503);
  try {
    // Preserve exact original HTTPS Resource URI and OAuth bearer for the
    // private Adapter. Core does not interpret OAuth or grant data access here.
    const response = await adapter.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return c.json({ error: "MCP resource unavailable" }, 503);
  }
}

async function privateValidation(c: Context<AppEnv>) {
  const presented = c.req.header("x-lifespace-internal-secret") || "";
  const secret = c.env.CORE_IDENTITY_SHARED_SECRET;
  if (!presented || !secret) return c.json({ error: "unauthorized" }, 401);
  const hash = async (value: string) => new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
  const [a, b] = await Promise.all([hash(presented), hash(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) return c.json({ error: "unauthorized" }, 401);
  const text = await c.req.text();
  if (text.length > 2048) return c.json({ data: { active: false } }, 200);
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || !("resource" in body)) {
    return c.json({ data: { active: false } }, 200);
  }
  const resource = (body as { resource?: unknown }).resource;
  const origin = expectedOrigin(c.env);
  if (!origin || typeof resource !== "string" || resource.length > 1024) {
    return c.json({ data: { active: false } }, 200);
  }
  let url: URL;
  try { url = new URL(resource); } catch { return c.json({ data: { active: false } }, 200); }
  const match = new RegExp("^/mcp/(mcp_[a-f0-9]{32})$", "u").exec(url.pathname);
  if (url.origin !== origin || url.href !== resource || !match
    || url.username || url.password || url.search || url.hash) {
    return c.json({ data: { active: false } }, 200);
  }
  const row = await c.env.DB.prepare(
    "SELECT enabled FROM mcp_server_definitions WHERE id=?"
  ).bind(match[1]).first<ServerState>();
  return c.json({ data: {
    active: row?.enabled === 1,
    ...(row?.enabled === 1 ? { resource, serverId: match[1] } : {}),
  } }, 200, { "cache-control": "no-store" });
}

export function registerMcpResourceIngressRoutes(app: App): void {
  // Private Identity -> Core check for currently enabled canonical Resources.
  // This returns no capability/Grant information and never bypasses Core auth.
  app.post("/internal/v1/oauth/mcp-resource/validate", privateValidation);
  app.get("/.well-known/oauth-protected-resource/mcp/:serverId", (c) =>
    forward(c, c.req.param("serverId")));
  app.all("/mcp/:serverId", (c) => forward(c, c.req.param("serverId")));
}
