import { ApiError } from "./http";

// Core owns the current MCP Server selection. OAuth Scope, current Agent
// authority, and this tool-exposure policy are independent restrictions.
type ServerRow = { enabled: number; config_json: string };
export type McpOAuthQueryPolicy = { serverId: string; queryModelKeys: string[]; toolModelKeys: string[]; modelOperations: Record<string, string[]>; personOperations: string[] };
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

// Public OAuth Scope discovery is a Server capability ceiling, never a
// Data Grant. Only Core may derive it from the current enabled Server config.
// The authenticated Agent/User/Client may still have strictly fewer rights.
export function configuredMcpOAuthScopes(configJson: string): string[] {
  let raw: unknown;
  try { raw = JSON.parse(configJson); } catch { throw forbidden(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw forbidden();
  const config = raw as { models?: unknown; resources?: unknown };
  if (!Array.isArray(config.models) || config.models.length > 32
    || (config.resources !== undefined && (!Array.isArray(config.resources) || config.resources.length > 1))) {
    throw forbidden();
  }
  // Match the canonical MCP Server operation language; no environment flag,
  // client claim, token Scope or user selection may widen this ceiling.
  const modelWrites = config.models.some(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw forbidden();
    const row = entry as { modelKey?: unknown; operations?: unknown };
    if (typeof row.modelKey !== "string" || !MODEL_KEY.test(row.modelKey)
      || !Array.isArray(row.operations) || !row.operations.length
      || row.operations.some(op => typeof op !== "string")) throw forbidden();
    return row.operations.some(op => ["create", "update", "delete"].includes(op));
  });
  const resources = config.resources ?? [];
  const personWrites = (resources as unknown[]).some(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw forbidden();
    const value = entry as {resourceKey?:unknown;operations?:unknown};
    if (value.resourceKey !== "person_directory" || !Array.isArray(value.operations)) throw forbidden();
    return value.operations.some(op => ["create","update","delete"].includes(op));
  });
  // Configured action operations are governed Changes. The exact published
  // action access requirement is checked again by Core on discovery/execution.
  const actions = config.models.some(entry =>
    (entry as {operations:string[]}).operations.some(op => op.startsWith("action:")));
  return ["resources:read", ...((modelWrites || personWrites || actions) ? ["resources:write"] : [])];
}

// Discover any Native Model with an actually exposed MCP operation. Query
// eligibility is still independent: a get-only Server must never gain Query.
export function allowedMcpToolModels(configJson: string): string[] {
  let raw: unknown;
  try { raw = JSON.parse(configJson); } catch { throw forbidden(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw forbidden();
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > 32) throw forbidden();
  const seen = new Set<string>(), allowed: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw forbidden();
    const { modelKey, operations } = entry as {modelKey?: unknown;operations?: unknown};
    if (typeof modelKey !== "string" || !MODEL_KEY.test(modelKey) || seen.has(modelKey)
      || !Array.isArray(operations) || !operations.length
      || operations.some(op => typeof op !== "string")) throw forbidden();
    seen.add(modelKey);
    if (operations.some(op => ["get","query","create","update","delete"].includes(op) || op.startsWith("action:"))) allowed.push(modelKey);
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
  const toolModelKeys = allowedMcpToolModels(row.config_json);
  const parsed = JSON.parse(row.config_json) as {
    models: Array<{modelKey:string;operations:string[]}>;
    resources?: Array<{resourceKey:string;operations:string[]}>;
  };
  const modelOperations = Object.fromEntries(parsed.models.map(m => [m.modelKey, m.operations]));
  const personOperations = parsed.resources?.find(r => r.resourceKey === "person_directory")?.operations ?? [];
  const selected = new Set(queryModelKeys);
  const gettable = new Set(toolModelKeys);

  if (method === "GET" && path === INVENTORY) return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  if (method === "GET" && new RegExp("^/api/v1/spaces/spc_[A-Za-z0-9_-]+/_discovery/operations$", "u").test(path)) {
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  if (method === "POST" && new RegExp("^/api/v1/spaces/spc_[A-Za-z0-9_-]+/_operations/op_[a-f0-9]{64}/invoke$", "u").test(path)) {
    // The executor resolves the opaque current operation and routes back
    // through existing canonical Core authorization; this is not a grant.
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  // The actual requested Model list is validated by the batch handler
  // against this freshly loaded policy before any semantics are returned.
  if (method === "POST" && /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/_discovery\/models\/batch$/u.test(path)) {
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  // Kernel Person is an independently granted resource, not a model.
  const person = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/people(?:\/(per_[A-Za-z0-9_-]+))?$/u.exec(path);
  const personOp = person && (method === "GET" ? (person[1] ? "get" : "list")
    : method === "POST" && !person[1] ? "create"
    : method === "PATCH" && person[1] ? "update"
    : method === "DELETE" && person[1] ? "delete" : null);
  if (personOp) {
    if (!personOperations.includes(personOp)) throw forbidden();
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  const action = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/models\/([a-z][a-z0-9_]{1,62})\/records\/rec_[A-Za-z0-9_-]+\/actions\/([a-z][a-z0-9_-]{0,62})$/u.exec(path);
  if (method === "POST" && action) {
    if (!modelOperations[action[1]]?.includes("action:" + action[2])) throw forbidden();
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  const mutation = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/models\/([a-z][a-z0-9_]{1,62})\/records(?:\/(rec_[A-Za-z0-9_-]+))?$/u.exec(path);
  const operation = method === "POST" && !mutation?.[2] ? "create"
    : method === "PATCH" && mutation?.[2] ? "update"
    : method === "DELETE" && mutation?.[2] ? "delete" : null;
  if (mutation && operation) {
    if (mutation[1].startsWith("ext_") || !modelOperations[mutation[1]]?.includes(operation)) throw forbidden();
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  const readRecord = /^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+\/models\/([a-z][a-z0-9_]{1,62})\/records\/rec_[A-Za-z0-9_-]+$/u.exec(path);
  if (method === "GET" && readRecord) {
    if (!gettable.has(readRecord[1]) || !modelOperations[readRecord[1]]?.includes("get")) throw forbidden();
    return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
  }
  const key = method === "GET" ? DETAIL_PATH.exec(path)?.[1]
    : method === "POST" ? QUERY_PATH.exec(path)?.[1] : null;
  if (!key || !(method === "GET" ? gettable.has(key) : selected.has(key))) throw forbidden();
  return { serverId, queryModelKeys, toolModelKeys, modelOperations, personOperations };
}
