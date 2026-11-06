import { ApiError } from "./http";

// Core owns the current MCP Server selection. OAuth Scope, current Agent
// authority, and this tool-exposure policy are independent restrictions.
type ServerRow = { enabled: number; config_json: string };
export type McpOAuthQueryPolicy = { serverId: string; queryModelKeys: string[] };
const SERVER_ID = /^mcp_[a-f0-9]{32}$/u;
const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/u;
const QUERY_PATH = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/models\/([a-z][a-z0-9_]{1,62})\/records\/query$/u;
const DETAIL_PATH = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/_discovery\/models\/([a-z][a-z0-9_]{1,62})$/u;
const INVENTORY = "/api/v1/me/_discovery/inventory";

function forbidden(): ApiError {
  return new ApiError("FORBIDDEN", "MCP Server is unavailable or does not expose this operation", 403);
}

export function oauthMcpServerId(resource: string): string | null {
  if (typeof resource !== "string" || resource.length > 1024) return null;
  try {
    const uri = new URL(resource);
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash || uri.search
      || uri.href !== resource || uri.hostname.includes("*")) return null;
    const match = /^\/mcp\/(mcp_[a-f0-9]{32})$/u.exec(uri.pathname);
    return match && SERVER_ID.test(match[1]) ? match[1] : null;
  } catch { return null; }
}

export function allowedMcpQueryModels(configJson: string): string[] {
  let config: unknown;
  try { config = JSON.parse(configJson); } catch { throw forbidden(); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw forbidden();
  const selections = (config as { models?: unknown }).models;
  if (!Array.isArray(selections) || selections.length > 32) throw forbidden();
  const seen = new Set<string>();
  const allowed: string[] = [];
  for (const entry of selections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw forbidden();
    const model = entry as { modelKey?: unknown; operations?: unknown };
    if (typeof model.modelKey !== "string" || !MODEL_KEY.test(model.modelKey)
      || seen.has(model.modelKey)
      || !Array.isArray(model.operations) || !model.operations.length
      || model.operations.some(op => typeof op !== "string")) throw forbidden();
    seen.add(model.modelKey);
    if (model.operations.includes("query")) allowed.push(model.modelKey);
  }
  return allowed.sort();
}

export async function currentMcpOAuthQueryPolicy(
  db: D1Database, resource: string, method: string, path: string,
): Promise<McpOAuthQueryPolicy> {
  const serverId = oauthMcpServerId(resource);
  if (!serverId) throw forbidden();
  const row = await db.prepare(
    "SELECT enabled,config_json FROM mcp_server_definitions WHERE id=?",
  ).bind(serverId).first<ServerRow>();
  if (!row || row.enabled !== 1) throw forbidden();
  const queryModelKeys = allowedMcpQueryModels(row.config_json);
  const selected = new Set(queryModelKeys);

  if (method === "GET" && path === INVENTORY) return { serverId, queryModelKeys };
  const key = method === "GET" ? DETAIL_PATH.exec(path)?.[1]
    : method === "POST" ? QUERY_PATH.exec(path)?.[1] : null;
  if (!key || !selected.has(key)) throw forbidden();
  return { serverId, queryModelKeys };
}
