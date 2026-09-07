import type { Hono } from "hono";
import type { ActorType, Bindings, PrincipalType, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type ResourceRow = { model_key: string };
type ChangeRow = {
  id: string;
  record_id: string;
  space_id: string;
  model_key: string;
  operation: "create" | "update" | "action" | "delete";
  version_before: number | null;
  version_after: number;
  principal_type: PrincipalType;
  principal_id: string;
  actor_type: ActorType;
  actor_id: string;
  application_id: string;
  delegation_id: string | null;
  changed_fields_json: string;
  occurred_at: string;
};

type ChangeCursor = {
  v: 1;
  recordId: string;
  versionAfter: number;
  occurredAt: string;
  id: string;
};

function dto(row: ChangeRow) {
  let changedFields: string[] = [];
  try {
    const parsed = JSON.parse(row.changed_fields_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) changedFields = parsed;
  } catch {
    changedFields = [];
  }
  return {
    id: row.id,
    recordId: row.record_id,
    spaceId: row.space_id,
    modelKey: row.model_key,
    operation: row.operation,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    principal: { type: row.principal_type, id: row.principal_id },
    actor: { type: row.actor_type, id: row.actor_id },
    applicationId: row.application_id,
    delegationId: row.delegation_id,
    changedFields,
    occurredAt: row.occurred_at,
  };
}

function encodeCursor(cursor: ChangeCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string, recordId: string): ChangeCursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ChangeCursor>;
    if (
      value.v !== 1
      || value.recordId !== recordId
      || !Number.isInteger(value.versionAfter)
      || Number(value.versionAfter) < 1
      || typeof value.occurredAt !== "string"
      || typeof value.id !== "string"
    ) throw new Error("invalid cursor");
    return value as ChangeCursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ApiError("INVALID_QUERY", `${key} may be supplied only once`, 400);
  return values[0] ?? undefined;
}

function parseLimit(params: URLSearchParams): number {
  const raw = one(params, "limit");
  if (raw === undefined) return 50;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
    throw new ApiError("INVALID_QUERY", "limit must be an integer between 1 and 100", 400);
  }
  return Number(raw);
}

function parseRecordId(params: URLSearchParams): string {
  const recordId = one(params, "recordId");
  if (!recordId || !/^rec_[A-Za-z0-9_-]+$/u.test(recordId) || recordId.length > 200) {
    throw new ApiError("INVALID_QUERY", "recordId must be a valid rec_* identifier", 400);
  }
  return recordId;
}

function validateQuery(params: URLSearchParams): void {
  const allowed = new Set(["recordId", "cursor", "limit"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Unsupported Change History query parameter: ${key}`, 400);
  }
}

async function authorizeRecord(appEnv: Bindings, principal: Variables["principal"], spaceId: string, recordId: string) {
  const resource = await appEnv.DB.prepare(`SELECT model_key FROM resource_records
    WHERE id=? AND space_id=? LIMIT 1`).bind(recordId, spaceId).first<ResourceRow>();
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  const model = await getRuntimeModel(appEnv, resource.model_key);
  if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  await requireModelAccess(appEnv, principal, spaceId, model, "read");
}

const CHANGE_SELECT = `SELECT
    id,record_id,space_id,model_key,operation,version_before,version_after,
    principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,
    changed_fields_json,occurred_at
  FROM resource_changes`;

async function listPage(
  env: Bindings,
  spaceId: string,
  recordId: string,
  limit: number,
  cursor: ChangeCursor | null,
) {
  const statement = cursor
    ? env.DB.prepare(`${CHANGE_SELECT}
        WHERE record_id=? AND space_id=? AND (
          version_after < ?
          OR (version_after = ? AND occurred_at < ?)
          OR (version_after = ? AND occurred_at = ? AND id < ?)
        )
        ORDER BY version_after DESC,occurred_at DESC,id DESC
        LIMIT ?`).bind(
        recordId,
        spaceId,
        cursor.versionAfter,
        cursor.versionAfter,
        cursor.occurredAt,
        cursor.versionAfter,
        cursor.occurredAt,
        cursor.id,
        limit + 1,
      )
    : env.DB.prepare(`${CHANGE_SELECT}
        WHERE record_id=? AND space_id=?
        ORDER BY version_after DESC,occurred_at DESC,id DESC
        LIMIT ?`).bind(recordId, spaceId, limit + 1);

  const rows = await statement.all<ChangeRow>();
  const pageRows = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(dto),
    nextCursor: hasMore && last
      ? encodeCursor({
        v: 1,
        recordId,
        versionAfter: last.version_after,
        occurredAt: last.occurred_at,
        id: last.id,
      })
      : null,
  };
}

async function listLegacy(env: Bindings, spaceId: string, recordId: string) {
  const rows = await env.DB.prepare(`${CHANGE_SELECT}
      WHERE record_id=? AND space_id=?
      ORDER BY version_after DESC,occurred_at DESC,id DESC
      LIMIT 100`).bind(recordId, spaceId).all<ChangeRow>();
  return { items: rows.results.map(dto) };
}

export function registerChangeHistoryRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/changes", async (context) => {
    const spaceId = context.req.param("spaceId");
    const params = new URL(context.req.url).searchParams;
    validateQuery(params);
    const recordId = parseRecordId(params);
    const limit = parseLimit(params);
    const rawCursor = one(params, "cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor, recordId) : null;

    await authorizeRecord(context.env, context.get("principal"), spaceId, recordId);
    return context.json(success(await listPage(context.env, spaceId, recordId, limit, cursor)));
  });

  // Kernel 0.29 compatibility alias. The canonical Change History resource is the
  // paginated collection route above; this legacy shape intentionally preserves
  // the historical first-100 response so already-pinned consumers are not broken.
  app.get("/api/v1/spaces/:spaceId/changes/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    const recordId = context.req.param("recordId");
    await authorizeRecord(context.env, context.get("principal"), spaceId, recordId);
    return context.json(success(await listLegacy(context.env, spaceId, recordId)));
  });
}
