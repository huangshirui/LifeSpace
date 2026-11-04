import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Json = Record<string, unknown>;
type Operation = "get" | "query" | "create" | "update" | "delete" | `action:${string}`;
type ModelSelection = { modelKey: string; operations: Operation[] };
type Draft = { models: ModelSelection[] };
type ServerRow = {
  id: string; server_key: string; display_name: string; description: string;
  status: "draft" | "published" | "withdrawn"; draft_json: string;
  draft_revision: number; published_revision: number | null;
  created_by_user_id: string; updated_by_user_id: string;
  created_at: string; updated_at: string; published_at: string | null; withdrawn_at: string | null;
};
type PublicationRow = { revision: number; manifest_json: string; manifest_hash: string; published_at: string; published_by_user_id: string };
type PublishedModelRow = { model_key: string; version: number; schema_hash: string; definition_json: string };

const KEY = /^[a-z][a-z0-9-]{1,39}$/u;
const MODEL = /^[a-z][a-z0-9_]{1,62}$/u;
const ACTION = /^action:([a-z][a-z0-9_-]{0,62})$/u;
const OPERATIONS = new Set(["get", "query", "create", "update", "delete"]);
const MAX_MODELS = 32;
const MAX_OPERATIONS = 32;
const now = () => new Date().toISOString();
const id = () => "mcp_" + crypto.randomUUID().replaceAll("-", "");
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function rejectKeys(value: Json, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", "Unexpected field in MCP Server configuration", 400);
  }
}
function serverKey(value: string): string {
  if (!KEY.test(value)) throw new ApiError("VALIDATION_ERROR", "Server key must be a lowercase slug of 2-40 characters", 422);
  return value;
}
function displayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 80) {
    throw new ApiError("VALIDATION_ERROR", "Server name must be 2-80 characters", 422);
  }
  return value.trim();
}
function description(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new ApiError("VALIDATION_ERROR", "Description must be at most 500 characters", 422);
  return value.trim();
}
function parseDraft(value: unknown): Draft {
  if (!isObject(value)) throw new ApiError("VALIDATION_ERROR", "Draft must be a JSON object", 422);
  rejectKeys(value, ["models"]);
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) {
    throw new ApiError("VALIDATION_ERROR", "models must contain at most 32 entries", 422);
  }
  const seen = new Set<string>();
  const models = value.models.map((item) => {
    if (!isObject(item)) throw new ApiError("VALIDATION_ERROR", "Model entry must be an object", 422);
    rejectKeys(item, ["modelKey", "operations"]);
    if (typeof item.modelKey !== "string" || !MODEL.test(item.modelKey) || seen.has(item.modelKey)) {
      throw new ApiError("VALIDATION_ERROR", "Model key is invalid or duplicated", 422);
    }
    seen.add(item.modelKey);
    if (!Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > MAX_OPERATIONS) {
      throw new ApiError("VALIDATION_ERROR", "Each model needs 1-32 operations", 422);
    }
    const operations = item.operations.map((value) => {
      if (typeof value !== "string" || (!OPERATIONS.has(value) && !ACTION.test(value))) {
        throw new ApiError("VALIDATION_ERROR", "Unsupported MCP model operation", 422);
      }
      return value as Operation;
    });
    if (new Set(operations).size !== operations.length) throw new ApiError("VALIDATION_ERROR", "Duplicate model operation", 422);
    return { modelKey: item.modelKey, operations: operations.sort() };
  });
  return { models: models.sort((a, b) => a.modelKey.localeCompare(b.modelKey)) };
}
function parseBody(value: unknown): Json {
  if (!isObject(value)) throw new ApiError("INVALID_REQUEST", "Expected a JSON object", 400);
  return value;
}
async function body(context: Context<AppEnv>): Promise<Json> {
  const text = await context.req.text();
  if (new TextEncoder().encode(text).byteLength > 32768) throw new ApiError("REQUEST_TOO_LARGE", "MCP Server request is too large", 413);
  let parsed: unknown;
  try { parsed = JSON.parse(text || "null") as unknown; }
  catch { throw new ApiError("INVALID_REQUEST", "Invalid MCP Server JSON body", 400); }
  return parseBody(parsed);
}
function rowDto(row: ServerRow, publication?: PublicationRow | null) {
  return {
    id: row.id, key: row.server_key, path: "/mcp/" + row.server_key,
    name: row.display_name, description: row.description, status: row.status,
    draftRevision: row.draft_revision, publishedRevision: row.published_revision,
    draft: JSON.parse(row.draft_json) as Draft,
    published: publication ? {
      revision: publication.revision, manifest: JSON.parse(publication.manifest_json) as unknown,
      manifestHash: publication.manifest_hash, publishedAt: publication.published_at,
    } : null,
    createdByUserId: row.created_by_user_id, updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    publishedAt: row.published_at, withdrawnAt: row.withdrawn_at,
  };
}
async function findServer(context: Context<AppEnv>, key: string): Promise<ServerRow> {
  const row = await context.env.DB.prepare("SELECT * FROM mcp_server_definitions WHERE server_key=?")
    .bind(serverKey(key)).first<ServerRow>();
  if (!row) throw new ApiError("MCP_SERVER_NOT_FOUND", "MCP Server not found", 404);
  return row;
}
async function currentPublication(context: Context<AppEnv>, row: ServerRow): Promise<PublicationRow | null> {
  if (row.published_revision === null) return null;
  return context.env.DB.prepare("SELECT * FROM mcp_server_publications WHERE server_id=? AND revision=?")
    .bind(row.id, row.published_revision).first<PublicationRow>();
}
function audit(context: Context<AppEnv>, admin: PlatformAdminContext, operation: string, targetId: string, details: Json): D1PreparedStatement {
  return context.env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    "paa_" + crypto.randomUUID().replaceAll("-", ""),
    admin.actor.id, admin.actor.clientId, admin.actor.tokenId,
    admin.executor.id, admin.executor.clientId, admin.executor.tokenId,
    operation, "mcp_server", targetId, JSON.stringify(details), context.get("requestId"), "success", now(),
  );
}
async function manifest(context: Context<AppEnv>, row: ServerRow): Promise<{ value: Json; hash: string }> {
  const draft = parseDraft(JSON.parse(row.draft_json) as unknown);
  if (!draft.models.length) throw new ApiError("VALIDATION_ERROR", "Add at least one Model before publishing", 422);
  const placeholders = draft.models.map(() => "?").join(",");
  const found = await context.env.DB.prepare(
    "SELECT model_key,version,schema_hash,definition_json FROM model_definitions WHERE state='published' AND model_key IN (" + placeholders + ")"
  ).bind(...draft.models.map((entry) => entry.modelKey)).all<PublishedModelRow>();
  const byKey = new Map(found.results.map((model) => [model.model_key, model]));
  const models = draft.models.map((selection) => {
    const model = byKey.get(selection.modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", "Model " + selection.modelKey + " is not currently published", 422);
    const definition = JSON.parse(model.definition_json) as { access?: unknown; actions?: unknown };
    const access = Array.isArray(definition.access) ? definition.access : [];
    const actions = isObject(definition.actions) ? definition.actions : {};
    for (const operation of selection.operations) {
      const action = ACTION.exec(operation);
      const candidate = action ? actions[action[1] ?? ""] : null;
      const required = action
        ? (isObject(candidate) ? candidate.access : null)
        : (operation === "query" || operation === "get" ? "read" : "write");
      if ((required !== "read" && required !== "write") || !access.includes(required)) {
        throw new ApiError("VALIDATION_ERROR", selection.modelKey + " does not publish the required capability for " + operation, 422);
      }
    }
    return {
      modelKey: selection.modelKey, modelVersion: model.version, schemaHash: model.schema_hash,
      operations: selection.operations,
    };
  });
  const value: Json = {
    key: row.server_key, path: "/mcp/" + row.server_key,
    name: row.display_name, description: row.description, models,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { value, hash };
}
function expectedRevision(input: Json, row: ServerRow): void {
  if (!Number.isInteger(input.expectedDraftRevision) || input.expectedDraftRevision !== row.draft_revision) {
    throw new ApiError("VERSION_CONFLICT", "MCP Server draft was modified; reload before continuing", 409);
  }
}

export function registerMcpServerGovernanceRoutes(app: App): void {
  const base = "/api/v1/platform-admin/mcp-servers";
  app.get(base, async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const value = context.req.query("limit");
    const limit = value === undefined ? 50 : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (context.req.queries("limit")?.length ?? 0) > 1) {
      throw new ApiError("VALIDATION_ERROR", "limit must be between 1 and 100", 422);
    }
    if (Object.keys(context.req.queries()).some((key) => key !== "limit")) throw new ApiError("INVALID_REQUEST", "Unexpected query parameter", 400);
    const rows = await context.env.DB.prepare("SELECT * FROM mcp_server_definitions ORDER BY server_key LIMIT ?")
      .bind(limit).all<ServerRow>();
    return context.json(success(rows.results.map((row) => rowDto(row))));
  });

  app.post(base, async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const input = await body(context);
    rejectKeys(input, ["key", "name", "description", "draft"]);
    const key = serverKey(String(input.key ?? ""));
    const name = displayName(input.name);
    const desc = description(input.description ?? "");
    const draft = parseDraft(input.draft ?? { models: [] });
    const existing = await context.env.DB.prepare("SELECT id FROM mcp_server_definitions WHERE server_key=?").bind(key).first();
    if (existing) throw new ApiError("MCP_SERVER_EXISTS", "MCP Server key already exists", 409);
    const serverId = id(); const stamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO mcp_server_definitions(
        id,server_key,display_name,description,status,draft_json,draft_revision,published_revision,
        created_by_user_id,updated_by_user_id,created_at,updated_at,published_at,withdrawn_at
      ) VALUES(?,?,?,?,'draft',?,1,NULL,?,?,?,?,NULL,NULL)`)
        .bind(serverId, key, name, desc, JSON.stringify(draft), admin.actor.id, admin.actor.id, stamp, stamp),
      audit(context, admin, "mcp_server.create", serverId, { key, name }),
    ]);
    const row = await findServer(context, key);
    return context.json(success(rowDto(row)), 201);
  });

  app.get(base + "/:serverKey", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const row = await findServer(context, context.req.param("serverKey") ?? "");
    return context.json(success(rowDto(row, await currentPublication(context, row))));
  });

  app.patch(base + "/:serverKey", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const row = await findServer(context, context.req.param("serverKey") ?? "");
    const input = await body(context);
    rejectKeys(input, ["name", "description", "draft", "expectedDraftRevision"]);
    expectedRevision(input, row);
    if (!Object.keys(input).some((key) => key !== "expectedDraftRevision")) throw new ApiError("INVALID_REQUEST", "No changes supplied", 400);
    const name = input.name === undefined ? row.display_name : displayName(input.name);
    const desc = input.description === undefined ? row.description : description(input.description);
    const draft = input.draft === undefined ? parseDraft(JSON.parse(row.draft_json) as unknown) : parseDraft(input.draft);
    const stamp = now();
    const statements = [
      context.env.DB.prepare(`UPDATE mcp_server_definitions SET display_name=?,description=?,draft_json=?,
        draft_revision=draft_revision+1,updated_by_user_id=?,updated_at=?
        WHERE id=? AND draft_revision=?`).bind(name, desc, JSON.stringify(draft), admin.actor.id, stamp, row.id, row.draft_revision),
      audit(context, admin, "mcp_server.update", row.id, { key: row.server_key, draftRevision: row.draft_revision + 1 }),
    ];
    const result = await context.env.DB.batch(statements);
    if (result[0].meta.changes !== 1) throw new ApiError("VERSION_CONFLICT", "MCP Server draft changed during update", 409);
    const updated = await findServer(context, row.server_key);
    return context.json(success(rowDto(updated, await currentPublication(context, updated))));
  });

  app.post(base + "/:serverKey/publish", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const row = await findServer(context, context.req.param("serverKey") ?? "");
    const input = await body(context);
    rejectKeys(input, ["expectedDraftRevision", "confirmKey"]);
    expectedRevision(input, row);
    if (input.confirmKey !== row.server_key) throw new ApiError("CONFIRMATION_REQUIRED", "Confirm the exact MCP Server key to publish", 422);
    const compiled = await manifest(context, row);
    const previous = await currentPublication(context, row);
    if (row.status === "published" && previous?.manifest_hash === compiled.hash) {
      throw new ApiError("NO_CHANGES", "Published definition already matches the draft", 409);
    }
    const revision = (row.published_revision ?? 0) + 1;
    const stamp = now();
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO mcp_server_publications(
        server_id,revision,manifest_json,manifest_hash,published_at,published_by_user_id
      ) VALUES(?,?,?,?,?,?)`).bind(row.id, revision, JSON.stringify(compiled.value), compiled.hash, stamp, admin.actor.id),
      context.env.DB.prepare(`UPDATE mcp_server_definitions SET status='published',published_revision=?,
        published_at=?,withdrawn_at=NULL,updated_at=?,updated_by_user_id=?
        WHERE id=? AND draft_revision=? AND COALESCE(published_revision,0)=?`)
        .bind(revision, stamp, stamp, admin.actor.id, row.id, row.draft_revision, row.published_revision ?? 0),
      audit(context, admin, "mcp_server.publish", row.id, { key: row.server_key, revision, manifestHash: compiled.hash }),
    ]);
    if (results[1].meta.changes !== 1) throw new ApiError("VERSION_CONFLICT", "MCP Server changed during publication", 409);
    const published = await findServer(context, row.server_key);
    return context.json(success(rowDto(published, await currentPublication(context, published))));
  });

  app.post(base + "/:serverKey/withdraw", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const row = await findServer(context, context.req.param("serverKey") ?? "");
    const input = await body(context);
    rejectKeys(input, ["confirmKey"]);
    if (input.confirmKey !== row.server_key) throw new ApiError("CONFIRMATION_REQUIRED", "Confirm the exact MCP Server key to withdraw", 422);
    if (row.status !== "published") throw new ApiError("INVALID_STATE", "Only published MCP Servers can be withdrawn", 409);
    const stamp = now();
    const result = await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE mcp_server_definitions SET status='withdrawn',
        withdrawn_at=?,updated_at=?,updated_by_user_id=? WHERE id=? AND status='published'`)
        .bind(stamp, stamp, admin.actor.id, row.id),
      audit(context, admin, "mcp_server.withdraw", row.id, { key: row.server_key, revision: row.published_revision }),
    ]);
    if (result[0].meta.changes !== 1) throw new ApiError("VERSION_CONFLICT", "MCP Server was changed", 409);
    const updated = await findServer(context, row.server_key);
    return context.json(success(rowDto(updated, await currentPublication(context, updated))));
  });

  app.get(base + "/:serverKey/revisions", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const row = await findServer(context, context.req.param("serverKey") ?? "");
    const results = await context.env.DB.prepare(
      "SELECT * FROM mcp_server_publications WHERE server_id=? ORDER BY revision DESC LIMIT 100"
    ).bind(row.id).all<PublicationRow>();
    return context.json(success(results.results.map((item) => ({
      revision: item.revision, manifestHash: item.manifest_hash,
      manifest: JSON.parse(item.manifest_json) as unknown,
      publishedAt: item.published_at, publishedByUserId: item.published_by_user_id,
    }))));
  });
}
