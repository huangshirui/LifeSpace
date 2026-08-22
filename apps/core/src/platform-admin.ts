import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AccessLevel = "read" | "write" | "manage";

type ApplicationModelAccessRow = {
  application_id: string;
  model_key: string;
  max_access: AccessLevel;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
};

type ModelRow = { key: string; definition_json: string; state: string };
type Body = { models?: unknown };

const ACCESS_RANK: Record<AccessLevel, number> = { read: 1, write: 2, manage: 3 };
const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function applicationId(value: string): string {
  if (!/^app_[A-Za-z0-9_-]{1,120}$/u.test(value)) throw new ApiError("VALIDATION_ERROR", "applicationId is invalid", 422);
  return value;
}

function parseDefinitionAccess(row: ModelRow): AccessLevel[] {
  const definition = JSON.parse(row.definition_json) as { access?: unknown };
  if (!Array.isArray(definition.access)) return [];
  return definition.access.filter((entry): entry is AccessLevel => entry === "read" || entry === "write" || entry === "manage");
}

async function normalizeEntries(context: Context<AppEnv>, value: unknown): Promise<Array<{ modelKey: string; maxAccess: AccessLevel }>> {
  if (!Array.isArray(value)) throw new ApiError("VALIDATION_ERROR", "models must be an array", 422);
  const seen = new Set<string>();
  const requested = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiError("VALIDATION_ERROR", "model access entry is invalid", 422);
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "modelKey" && key !== "maxAccess")) {
      throw new ApiError("INVALID_REQUEST", "model access entries may contain only modelKey and maxAccess", 400);
    }
    if (typeof record.modelKey !== "string" || !/^[a-z][a-z0-9_]{1,62}$/u.test(record.modelKey)) {
      throw new ApiError("VALIDATION_ERROR", "modelKey is invalid", 422);
    }
    if (record.maxAccess !== "read" && record.maxAccess !== "write" && record.maxAccess !== "manage") {
      throw new ApiError("VALIDATION_ERROR", "maxAccess must be read, write or manage", 422);
    }
    if (seen.has(record.modelKey)) throw new ApiError("VALIDATION_ERROR", `Duplicate model access ${record.modelKey}`, 422);
    seen.add(record.modelKey);
    return { modelKey: record.modelKey, maxAccess: record.maxAccess as AccessLevel };
  });

  if (!requested.length) return requested;
  const placeholders = requested.map(() => "?").join(",");
  const rows = await context.env.DB.prepare(`SELECT model_key key,definition_json,state FROM model_definitions
    WHERE state='published' AND model_key IN (${placeholders})`).bind(...requested.map((entry) => entry.modelKey)).all<ModelRow>();
  const byKey = new Map(rows.results.map((row) => [row.key, row]));
  for (const entry of requested) {
    const model = byKey.get(entry.modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${entry.modelKey} was not found`, 404);
    const exposed = parseDefinitionAccess(model);
    if (!exposed.includes(entry.maxAccess)) {
      const strongest = exposed.reduce<AccessLevel | null>((best, candidate) => best === null || ACCESS_RANK[candidate] > ACCESS_RANK[best] ? candidate : best, null);
      throw new ApiError("VALIDATION_ERROR", `Model ${entry.modelKey} does not expose ${entry.maxAccess} access${strongest ? `; maximum is ${strongest}` : ""}`, 422);
    }
  }
  return requested;
}

function dto(row: ApplicationModelAccessRow) {
  return {
    applicationId: row.application_id,
    modelKey: row.model_key,
    maxAccess: row.max_access,
    createdBy: { type: row.created_by_type, id: row.created_by_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditStatement(
  env: Bindings,
  admin: PlatformAdminContext,
  requestId: string,
  targetId: string,
  summary: unknown,
) {
  return env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    createId("paa"),
    admin.actor.id,
    admin.actor.clientId,
    admin.actor.tokenId,
    admin.executor.id,
    admin.executor.clientId,
    admin.executor.tokenId,
    "application_model_access.replace",
    "application",
    targetId,
    JSON.stringify(summary),
    requestId,
    "success",
    now(),
  );
}

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "models")) throw new ApiError("INVALID_REQUEST", "Request must contain only models", 400);
  return record as Body;
}

export function registerPlatformAdminRoutes(app: App): void {
  app.get("/api/v1/platform-admin/applications/:applicationId/model-access", async (context) => {
    await requirePlatformAdminContext(context, "applications:manage");
    const targetApplicationId = applicationId(context.req.param("applicationId"));
    const rows = await context.env.DB.prepare(`SELECT application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      FROM application_model_access WHERE application_id=? ORDER BY model_key`).bind(targetApplicationId).all<ApplicationModelAccessRow>();
    return context.json(success({ applicationId: targetApplicationId, models: rows.results.map(dto) }));
  });

  app.put("/api/v1/platform-admin/applications/:applicationId/model-access", async (context) => {
    const admin = await requirePlatformAdminContext(context, "applications:manage");
    const targetApplicationId = applicationId(context.req.param("applicationId"));
    const input = await body(context);
    const entries = await normalizeEntries(context, input.models);
    const timestamp = now();
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare("DELETE FROM application_model_access WHERE application_id=?").bind(targetApplicationId),
      ...entries.map((entry) => context.env.DB.prepare(`INSERT INTO application_model_access(
        application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`).bind(
        targetApplicationId,
        entry.modelKey,
        entry.maxAccess,
        "user",
        admin.actor.id,
        timestamp,
        timestamp,
      )),
      auditStatement(context.env, admin, context.get("requestId"), targetApplicationId, { models: entries }),
    ];
    await context.env.DB.batch(statements);
    const rows = await context.env.DB.prepare(`SELECT application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      FROM application_model_access WHERE application_id=? ORDER BY model_key`).bind(targetApplicationId).all<ApplicationModelAccessRow>();
    return context.json(success({ applicationId: targetApplicationId, models: rows.results.map(dto) }));
  });

  app.get("/api/v1/platform-admin/audit", async (context) => {
    await requirePlatformAdminContext(context, "audit:read");
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("VALIDATION_ERROR", "limit must be an integer between 1 and 200", 422);
    const rows = await context.env.DB.prepare(`SELECT id,actor_user_id actorUserId,actor_application_id actorApplicationId,
      executor_principal_id executorPrincipalId,executor_application_id executorApplicationId,
      operation,target_type targetType,target_id targetId,summary_json summaryJson,request_id requestId,result,created_at createdAt
      FROM platform_admin_audit ORDER BY created_at DESC,id DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
    return context.json(success(rows.results.map((row) => ({ ...row, summary: JSON.parse(String(row.summaryJson ?? "{}")), summaryJson: undefined }))));
  });
}
