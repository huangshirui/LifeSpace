import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Json = Record<string, unknown>;
type Operation = "get" | "query" | "create" | "update" | "delete" | `action:${string}`;
type PersonOperation = "list" | "get" | "create" | "update" | "delete";
type ModelSelection = { modelKey: string; operations: Operation[] };
type ResourceSelection = { resourceKey: "person_directory"; operations: PersonOperation[] };
type Configuration = { models: ModelSelection[]; resources?: ResourceSelection[] };
type ServerRow = {
  id: string; display_name: string; description: string; enabled: number;
  config_json: string; revision: number; created_by_user_id: string;
  updated_by_user_id: string; created_at: string; updated_at: string;
};
type ModelRow = { model_key: string; definition_json: string };

const ID = /^mcp_[a-f0-9]{32}$/u;
const MODEL = /^[a-z][a-z0-9_]{1,62}$/u;
const ACTION = /^action:([a-z][a-z0-9_-]{0,62})$/u;
const OPERATIONS = new Set(["get", "query", "create", "update", "delete"]);
const PERSON_OPERATIONS = new Set(["list", "get", "create", "update", "delete"]);
const now = () => new Date().toISOString();
const newId = () => "mcp_" + crypto.randomUUID().replaceAll("-", "");
const object = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function rejectKeys(value: Json, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", "Unsupported MCP Server field", 400);
  }
}
function serverId(value: string): string {
  if (!ID.test(value)) throw new ApiError("MCP_SERVER_NOT_FOUND", "MCP Server not found", 404);
  return value;
}
function name(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 80) {
    throw new ApiError("VALIDATION_ERROR", "Name must be 2-80 characters", 422);
  }
  return value.trim();
}
function description(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) {
    throw new ApiError("VALIDATION_ERROR", "Description must be at most 500 characters", 422);
  }
  return value.trim();
}
function configuration(value: unknown, allowEmpty = false): Configuration {
  if (!object(value)) throw new ApiError("VALIDATION_ERROR", "Configuration must be an object", 422);
  rejectKeys(value, ["models", "resources"]);
  if (!Array.isArray(value.models) || value.models.length > 32) {
    throw new ApiError("VALIDATION_ERROR", "models must contain at most 32 entries", 422);
  }
  const keys = new Set<string>();
  const models = value.models.map((item) => {
    if (!object(item)) throw new ApiError("VALIDATION_ERROR", "Model entry must be an object", 422);
    rejectKeys(item, ["modelKey", "operations"]);
    if (typeof item.modelKey !== "string" || !MODEL.test(item.modelKey) || keys.has(item.modelKey)) {
      throw new ApiError("VALIDATION_ERROR", "Invalid or duplicate modelKey", 422);
    }
    keys.add(item.modelKey);
    if (!Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > 32) {
      throw new ApiError("VALIDATION_ERROR", "Each model requires 1-32 operations", 422);
    }
    const operations = item.operations.map((op) => {
      if (typeof op !== "string" || (!OPERATIONS.has(op) && !ACTION.test(op))) {
        throw new ApiError("VALIDATION_ERROR", "Unsupported model operation", 422);
      }
      return op as Operation;
    });
    if (new Set(operations).size !== operations.length) throw new ApiError("VALIDATION_ERROR", "Duplicate model operation", 422);
    return { modelKey: item.modelKey, operations: operations.sort() };
  }).sort((a,b) => a.modelKey.localeCompare(b.modelKey));
  if (value.resources === undefined) {
    if (!allowEmpty && !models.length) throw new ApiError("VALIDATION_ERROR", "Select at least one Model or Person Directory", 422);
    return { models };
  }
  if (!Array.isArray(value.resources) || value.resources.length > 1) {
    throw new ApiError("VALIDATION_ERROR", "Only Person Directory Kernel resource is supported", 422);
  }
  const resources = value.resources.map((item) => {
    if (!object(item)) throw new ApiError("VALIDATION_ERROR", "Kernel resource must be an object", 422);
    rejectKeys(item, ["resourceKey", "operations"]);
    if (item.resourceKey !== "person_directory") throw new ApiError("VALIDATION_ERROR", "Unknown Kernel resource", 422);
    if (!Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > 5) {
      throw new ApiError("VALIDATION_ERROR", "Person Directory requires 1-5 operations", 422);
    }
    const operations = item.operations.map((op) => {
      if (typeof op !== "string" || !PERSON_OPERATIONS.has(op)) {
        throw new ApiError("VALIDATION_ERROR", "Unsupported Person Directory operation", 422);
      }
      return op as PersonOperation;
    });
    if (new Set(operations).size !== operations.length) throw new ApiError("VALIDATION_ERROR", "Duplicate Person Directory operation", 422);
    return { resourceKey: "person_directory" as const, operations: operations.sort() };
  });
  if (!allowEmpty && !models.length && !resources.length) {
    throw new ApiError("VALIDATION_ERROR", "Select at least one Model or Person Directory", 422);
  }
  return { models, resources };
}
async function validateModels(context: Context<AppEnv>, config: Configuration): Promise<void> {
  if (!config.models.length) return;
  const placeholders = config.models.map(() => "?").join(",");
  const records = await context.env.DB.prepare(
    "SELECT model_key, definition_json FROM model_definitions WHERE state='published' AND model_key IN (" + placeholders + ")"
  ).bind(...config.models.map((entry) => entry.modelKey)).all<ModelRow>();
  const models = new Map(records.results.map((row) => [row.model_key, row]));
  for (const entry of config.models) {
    const found = models.get(entry.modelKey);
    if (!found) throw new ApiError("MODEL_NOT_FOUND", "Model " + entry.modelKey + " is not published", 422);
    const definition = JSON.parse(found.definition_json) as { access?: unknown; actions?: unknown };
    const access = Array.isArray(definition.access) ? definition.access : [];
    const actions = object(definition.actions) ? definition.actions : {};
    for (const operation of entry.operations) {
      const action = ACTION.exec(operation);
      const candidate = action ? actions[action[1] ?? ""] : null;
      const required = action
        ? object(candidate) ? candidate.access : null
        : operation === "get" || operation === "query" ? "read" : "write";
      if ((required !== "read" && required !== "write") || !access.includes(required)) {
        throw new ApiError("VALIDATION_ERROR", entry.modelKey + " has no published capability " + operation, 422);
      }
    }
  }
}
function dto(row: ServerRow) {
  return {
    id: row.id, path: "/mcp/" + row.id, name: row.display_name,
    description: row.description, enabled: row.enabled === 1,
    revision: row.revision, configuration: JSON.parse(row.config_json) as Configuration,
    createdAt: row.created_at, updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id, updatedByUserId: row.updated_by_user_id,
  };
}
async function read(context: Context<AppEnv>, id: string): Promise<ServerRow> {
  const row = await context.env.DB.prepare("SELECT * FROM mcp_server_definitions WHERE id=?")
    .bind(serverId(id)).first<ServerRow>();
  if (!row) throw new ApiError("MCP_SERVER_NOT_FOUND", "MCP Server not found", 404);
  return row;
}
async function body(context: Context<AppEnv>): Promise<Json> {
  const raw = await context.req.text();
  if (new TextEncoder().encode(raw).byteLength > 32768) {
    throw new ApiError("REQUEST_TOO_LARGE", "MCP Server request exceeds 32 KiB", 413);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "null") as unknown; }
  catch { throw new ApiError("INVALID_REQUEST", "Invalid JSON request body", 400); }
  if (!object(parsed)) throw new ApiError("INVALID_REQUEST", "Expected a JSON object", 400);
  return parsed;
}
function expectedRevision(value: unknown, current: number): void {
  if (!Number.isInteger(value) || value !== current) {
    throw new ApiError("VERSION_CONFLICT", "Server configuration was changed; reload before saving", 409);
  }
}
// Insert audit only if the Server exists at the expected *new* revision.
// In a D1 batch this suppresses audit success for a failed optimistic update.
function audit(context: Context<AppEnv>, admin: PlatformAdminContext, operation: string,
               targetId: string, details: Json, revision: number): D1PreparedStatement {
  return context.env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM mcp_server_definitions WHERE id=? AND revision=?)`).bind(
    "paa_" + crypto.randomUUID().replaceAll("-", ""),
    admin.actor.id, admin.actor.clientId, admin.actor.tokenId,
    admin.executor.id, admin.executor.clientId, admin.executor.tokenId,
    operation, "mcp_server", targetId, JSON.stringify(details), context.get("requestId"), "success", now(),
    targetId, revision,
  );
}

export function registerMcpServerGovernanceRoutes(app: App): void {
  const base = "/api/v1/platform-admin/mcp-servers";
  app.get(base, async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const limitInput = context.req.query("limit");
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (context.req.queries("limit")?.length ?? 0) > 1) {
      throw new ApiError("VALIDATION_ERROR", "limit must be 1-100", 422);
    }
    if (Object.keys(context.req.queries()).some((key) => key !== "limit")) {
      throw new ApiError("INVALID_REQUEST", "Unexpected query parameter", 400);
    }
    const rows = await context.env.DB.prepare(
      "SELECT * FROM mcp_server_definitions ORDER BY display_name COLLATE NOCASE, id LIMIT ?"
    ).bind(limit).all<ServerRow>();
    return context.json(success(rows.results.map(dto)));
  });

  app.post(base, async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const input = await body(context);
    rejectKeys(input, ["name", "description", "configuration"]);
    const title = name(input.name);
    const desc = description(input.description ?? "");
    const config = configuration(input.configuration);
    await validateModels(context, config);
    const id = newId(), stamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO mcp_server_definitions(
        id,display_name,description,enabled,config_json,revision,
        created_by_user_id,updated_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,1,?,1,?,?,?,?)`).bind(
        id, title, desc, JSON.stringify(config), admin.actor.id, admin.actor.id, stamp, stamp,
      ),
      audit(context, admin, "mcp_server.create", id, { serverId: id, enabled: true, models: config.models.length,
        resources: config.resources?.length ?? 0 }, 1),
    ]);
    return context.json(success(dto(await read(context, id))), 201);
  });

  app.get(base + "/:serverId", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    return context.json(success(dto(await read(context, context.req.param("serverId") ?? ""))));
  });

  app.patch(base + "/:serverId", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const row = await read(context, context.req.param("serverId") ?? "");
    const input = await body(context);
    rejectKeys(input, ["expectedRevision", "name", "description", "configuration", "enabled", "confirmId"]);
    expectedRevision(input.expectedRevision, row.revision);
    const changingState = input.enabled !== undefined;
    if (changingState) {
      if (typeof input.enabled !== "boolean" || input.confirmId !== row.id) {
        throw new ApiError("CONFIRMATION_REQUIRED", "Changing availability requires the exact Server ID", 422);
      }
      if (Object.keys(input).some((key) => !["expectedRevision", "enabled", "confirmId"].includes(key))) {
        throw new ApiError("INVALID_REQUEST", "Availability change must be a separate operation", 400);
      }
      if (input.enabled === Boolean(row.enabled)) throw new ApiError("NO_CHANGES", "Availability already matches", 409);
    } else {
      if (input.confirmId !== undefined) throw new ApiError("INVALID_REQUEST", "Unexpected confirmation", 400);
      if (input.name === undefined && input.description === undefined && input.configuration === undefined) {
        throw new ApiError("INVALID_REQUEST", "No configuration changes supplied", 400);
      }
    }
    const title = input.name === undefined ? row.display_name : name(input.name);
    const desc = input.description === undefined ? row.description : description(input.description);
    const config = input.configuration === undefined
      ? configuration(JSON.parse(row.config_json) as unknown, !row.enabled && input.enabled !== true)
      : configuration(input.configuration);
    if (changingState && input.enabled === true && !config.models.length && !config.resources?.length) {
      throw new ApiError("VALIDATION_ERROR", "Configure resources before enabling", 422);
    }
    // Disabling is fail-closed and must remain possible even when a previously
    // configured Model has since been retired. Enabling or editing must validate.
    if (!(changingState && input.enabled === false)) await validateModels(context, config);
    const enabled = changingState ? Number(input.enabled) : row.enabled;
    const stamp = now();
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE mcp_server_definitions SET
        display_name=?,description=?,config_json=?,enabled=?,revision=revision+1,
        updated_by_user_id=?,updated_at=? WHERE id=? AND revision=?`).bind(
          title, desc, JSON.stringify(config), enabled, admin.actor.id, stamp, row.id, row.revision,
        ),
      audit(context, admin, changingState ? enabled ? "mcp_server.enable" : "mcp_server.disable"
        : "mcp_server.update", row.id, { serverId: row.id, revision: row.revision + 1, enabled: Boolean(enabled) },
      row.revision + 1),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new ApiError("VERSION_CONFLICT", "Server changed during save", 409);
    }
    return context.json(success(dto(await read(context, row.id))));
  });
}
