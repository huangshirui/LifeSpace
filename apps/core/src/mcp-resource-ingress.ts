import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const SERVER_ID = /^mcp_[a-f0-9]{32}$/u;
type ServerState = { enabled: number };

function expectedOrigin(env: Bindings): string | null {
  if (env.ENVIRONMENT === "production") return "https://core.aisr.online";
  if (env.ENVIRONMENT === "staging") return "https://core-staging.aisr.online";
  // Local/test environments must explicitly opt in; never trust Host alone.
  if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "staging"
    && env.MCP_PUBLIC_ORIGIN && /^https:\/\/[a-z0-9.-]+$/u.test(env.MCP_PUBLIC_ORIGIN)) {
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

export function registerMcpResourceIngressRoutes(app: App): void {
  app.get("/.well-known/oauth-protected-resource/mcp/:serverId", (c) =>
    forward(c, c.req.param("serverId")));
  app.all("/mcp/:serverId", (c) => forward(c, c.req.param("serverId")));
}
