import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import {
  createGrantId,
  grantDto,
  grantNow,
  parseGrantBody,
  parseGrantExpiry,
  parseGrantGrantee,
  parseGrantPermission,
  parseGrantResource,
  validateModelPermission,
  type GrantRow,
} from "./grants";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";
import {
  getPublishedModel,
  listPublishedModels,
  publishModelDefinition,
  retireModel,
  validateDefinitionForPublication,
  type ModelCompatibility,
} from "./model-registry";
import { getExternalModel, isExternalModelKey, externalAuthorityModel } from "./external-model";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AccessLevel = "read" | "write" | "manage";
type PendingAudit = { id: string; admin: PlatformAdminContext };

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
type ModelAccessBody = { models?: unknown };
type JsonBody = Record<string, unknown>;

const ACCESS_RANK: Record<AccessLevel, number> = { read: 1, write: 2, manage: 3 };
const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function applicationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value)) throw new ApiError("VALIDATION_ERROR", "applicationId is invalid", 422);
  return value;
}

function spaceId(value: string): string {
  if (!/^spc_[A-Za-z0-9_-]+$/u.test(value)) throw new ApiError("VALIDATION_ERROR", "spaceId is invalid", 422);
  return value;
}

function grantId(value: string): string {
  if (!/^grt_[A-Za-z0-9_-]+$/u.test(value)) throw new ApiError("VALIDATION_ERROR", "grantId is invalid", 422);
  return value;
}

function modelKey(value: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/u.test(value)) throw new ApiError("VALIDATION_ERROR", "modelKey is invalid", 422);
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
    let exposed: AccessLevel[];
    if (!model && isExternalModelKey(entry.modelKey)) {
      const row = await context.env.DB.prepare("SELECT space_id FROM external_models WHERE model_key=? AND status!='disabled'").bind(entry.modelKey).first<{space_id:string}>();
      const external = row ? await getExternalModel(context.env,row.space_id,entry.modelKey) : null;
      if (!external) throw new ApiError("MODEL_NOT_FOUND", "Model not found",404);
      exposed = externalAuthorityModel(external).definition.access;
    } else {
      if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${entry.modelKey} was not found`,404);
      exposed = parseDefinitionAccess(model);
    }
    if (!exposed.includes(entry.maxAccess)) {
      const strongest = exposed.reduce<AccessLevel | null>((best, candidate) => best === null || ACCESS_RANK[candidate] > ACCESS_RANK[best] ? candidate : best, null);
      throw new ApiError("VALIDATION_ERROR", `Model ${entry.modelKey} does not expose ${entry.maxAccess} access${strongest ? `; maximum is ${strongest}` : ""}`, 422);
    }
  }
  return requested;
}

function modelAccessDto(row: ApplicationModelAccessRow) {
  return {
    applicationId: row.application_id,
    modelKey: row.model_key,
    maxAccess: row.max_access,
    createdBy: { type: row.created_by_type, id: row.created_by_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publishedModelDto(model: Awaited<ReturnType<typeof getPublishedModel>>) {
  if (!model) return null;
  return {
    id: model.id,
    key: model.key,
    version: model.version,
    state: model.state,
    schemaHash: model.schemaHash,
    compatibility: model.compatibility,
    definition: model.definition,
    publishedAt: model.publishedAt,
  };
}

function auditStatement(
  env: Bindings,
  admin: PlatformAdminContext,
  requestId: string,
  operation: string,
  targetType: string,
  targetId: string,
  summary: unknown,
  result: "success" | "failure" = "success",
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
    operation,
    targetType,
    targetId,
    JSON.stringify(summary),
    requestId,
    result,
    now(),
  );
}

async function beginPendingAudit(
  context: Context<AppEnv>,
  admin: PlatformAdminContext,
  operation: string,
  targetType: string,
  targetId: string,
  summary: unknown,
): Promise<PendingAudit> {
  const id = createId("paa");
  await context.env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id,
    admin.actor.id,
    admin.actor.clientId,
    admin.actor.tokenId,
    admin.executor.id,
    admin.executor.clientId,
    admin.executor.tokenId,
    operation,
    targetType,
    targetId,
    JSON.stringify(summary),
    context.get("requestId"),
    "pending",
    now(),
  ).run();
  return { id, admin };
}

async function finishPendingAudit(context: Context<AppEnv>, audit: PendingAudit, result: "success" | "failure", summary: unknown): Promise<void> {
  await context.env.DB.prepare("UPDATE platform_admin_audit SET result=?,summary_json=? WHERE id=? AND result='pending'")
    .bind(result, JSON.stringify(summary), audit.id).run();
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "INTERNAL_ERROR";
}

async function modelAccessBody(context: Context<AppEnv>): Promise<ModelAccessBody> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "models")) throw new ApiError("INVALID_REQUEST", "Request must contain only models", 400);
  return record as ModelAccessBody;
}

async function jsonBody(context: Context<AppEnv>): Promise<JsonBody> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  return value as JsonBody;
}

function compatibility(value: unknown): ModelCompatibility {
  if (value !== "initial" && value !== "compatible" && value !== "breaking") {
    throw new ApiError("INVALID_REQUEST", "compatibility must be initial, compatible, or breaking", 400);
  }
  return value;
}

function modelKeyFromDefinition(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const key = (value as Record<string, unknown>).key;
    if (typeof key === "string" && key.trim()) return key.trim().slice(0, 100);
  }
  return "unresolved";
}

async function requireActiveSpace(context: Context<AppEnv>, id: string): Promise<void> {
  const row = await context.env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL").bind(id).first<{ id: string }>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
}

export function registerPlatformAdminRoutes(app: App): void {
  app.get("/api/v1/platform-admin/applications/:applicationId/model-access", async (context) => {
    await requirePlatformAdminContext(context, "applications:manage");
    const targetApplicationId = applicationId(context.req.param("applicationId"));
    const rows = await context.env.DB.prepare(`SELECT application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      FROM application_model_access WHERE application_id=? ORDER BY model_key`).bind(targetApplicationId).all<ApplicationModelAccessRow>();
    return context.json(success({ applicationId: targetApplicationId, models: rows.results.map(modelAccessDto) }));
  });

  app.put("/api/v1/platform-admin/applications/:applicationId/model-access", async (context) => {
    const admin = await requirePlatformAdminContext(context, "applications:manage");
    const targetApplicationId = applicationId(context.req.param("applicationId"));
    const input = await modelAccessBody(context);
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
      auditStatement(context.env, admin, context.get("requestId"), "application_model_access.replace", "application", targetApplicationId, { models: entries }),
    ];
    await context.env.DB.batch(statements);
    const rows = await context.env.DB.prepare(`SELECT application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      FROM application_model_access WHERE application_id=? ORDER BY model_key`).bind(targetApplicationId).all<ApplicationModelAccessRow>();
    return context.json(success({ applicationId: targetApplicationId, models: rows.results.map(modelAccessDto) }));
  });

  app.post("/api/v1/platform-admin/spaces/:spaceId/grants", async (context) => {
    const admin = await requirePlatformAdminContext(context, "grants:manage");
    const targetSpaceId = spaceId(context.req.param("spaceId"));
    await requireActiveSpace(context, targetSpaceId);
    const input = await parseGrantBody(context.req.raw);
    const allowedFields = new Set(["granteeType", "granteeId", "resourceType", "resourceId", "permission", "expiresAt"]);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) throw new ApiError("INVALID_REQUEST", "Request contains unsupported fields", 400);
    const grantee = parseGrantGrantee(input);
    const permission = parseGrantPermission(input.permission);
    const resource = await parseGrantResource(context.env, targetSpaceId, input);
    validateModelPermission(resource.resourceType, permission);
    const expiresAt = parseGrantExpiry(input.expiresAt);
    const id = createGrantId();
    const createdAt = grantNow();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO data_grants(
        id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
        id,
        targetSpaceId,
        grantee.granteeType,
        grantee.granteeId,
        resource.resourceType,
        resource.resourceId,
        permission,
        admin.actor.id,
        createdAt,
        expiresAt,
      ),
      auditStatement(context.env, admin, context.get("requestId"), "data_grant.create", "data_grant", id, {
        sourceSpaceId: targetSpaceId,
        ...grantee,
        ...resource,
        permission,
        expiresAt,
      }),
    ]);
    const row = await context.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=?`).bind(id).first<GrantRow>();
    if (!row) throw new Error("Data Grant missing after platform-admin create");
    return context.json(success(grantDto(row)), 201);
  });

  app.patch("/api/v1/platform-admin/spaces/:spaceId/grants/:grantId", async (context) => {
    const admin = await requirePlatformAdminContext(context, "grants:manage");
    const targetSpaceId = spaceId(context.req.param("spaceId"));
    const targetGrantId = grantId(context.req.param("grantId"));
    const current = await context.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=? AND source_space_id=? AND revoked_at IS NULL`).bind(targetGrantId, targetSpaceId).first<GrantRow>();
    if (!current) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    const input = await jsonBody(context);
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !["permission", "expiresAt"].includes(key))) throw new ApiError("INVALID_REQUEST", "Only permission and expiresAt may be updated", 400);
    const permission = input.permission === undefined ? current.permission : parseGrantPermission(input.permission);
    validateModelPermission(current.resource_type, permission);
    const expiresAt = input.expiresAt === undefined ? current.expires_at : parseGrantExpiry(input.expiresAt);
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE data_grants SET permission=?,expires_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL")
        .bind(permission, expiresAt, targetGrantId, targetSpaceId),
      auditStatement(context.env, admin, context.get("requestId"), "data_grant.update", "data_grant", targetGrantId, {
        sourceSpaceId: targetSpaceId,
        before: { permission: current.permission, expiresAt: current.expires_at },
        after: { permission, expiresAt },
      }),
    ]);
    const updated = await context.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=?`).bind(targetGrantId).first<GrantRow>();
    if (!updated) throw new Error("Data Grant missing after platform-admin update");
    return context.json(success(grantDto(updated)));
  });

  app.delete("/api/v1/platform-admin/spaces/:spaceId/grants/:grantId", async (context) => {
    const admin = await requirePlatformAdminContext(context, "grants:manage");
    const targetSpaceId = spaceId(context.req.param("spaceId"));
    const targetGrantId = grantId(context.req.param("grantId"));
    const current = await context.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=? AND source_space_id=? AND revoked_at IS NULL`).bind(targetGrantId, targetSpaceId).first<GrantRow>();
    if (!current) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    const revokedAt = grantNow();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE data_grants SET revoked_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL").bind(revokedAt, targetGrantId, targetSpaceId),
      auditStatement(context.env, admin, context.get("requestId"), "data_grant.revoke", "data_grant", targetGrantId, {
        sourceSpaceId: targetSpaceId,
        granteeType: current.grantee_type,
        granteeId: current.grantee_id,
        resourceType: current.resource_type,
        resourceId: current.resource_id,
        permission: current.permission,
        expiresAt: current.expires_at,
        revokedAt,
      }),
    ]);
    return context.body(null, 204);
  });

  app.get("/api/v1/platform-admin/models", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const models = await listPublishedModels(context.env);
    return context.json(success(models.map((model) => publishedModelDto(model))));
  });

  app.get("/api/v1/platform-admin/models/:modelKey", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const key = modelKey(context.req.param("modelKey"));
    const model = await getPublishedModel(context.env, key);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
    return context.json(success(publishedModelDto(model)));
  });

  app.post("/api/v1/platform-admin/models/validate", async (context) => {
    await requirePlatformAdminContext(context, "models:manage");
    const input = await jsonBody(context);
    if (Object.keys(input).some((key) => key !== "definition") || input.definition === undefined) {
      throw new ApiError("INVALID_REQUEST", "Request must contain only definition", 400);
    }
    return context.json(success(await validateDefinitionForPublication(context.env, input.definition)));
  });

  app.post("/api/v1/platform-admin/models", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const input = await jsonBody(context);
    if (Object.keys(input).some((key) => key !== "definition" && key !== "compatibility") || input.definition === undefined) {
      throw new ApiError("INVALID_REQUEST", "Request must contain definition and compatibility", 400);
    }
    const requestedCompatibility = compatibility(input.compatibility);
    const key = modelKeyFromDefinition(input.definition);
    const audit = await beginPendingAudit(context, admin, "model.publish", "model", key, { modelKey: key, compatibility: requestedCompatibility });
    try {
      const published = await publishModelDefinition(context.env, admin.executor, input.definition, requestedCompatibility);
      try {
        await finishPendingAudit(context, audit, "success", {
          modelKey: published.key,
          version: published.version,
          schemaHash: published.schemaHash,
          compatibility: published.compatibility,
        });
      } catch (error) {
        console.error(JSON.stringify({ message: "Platform model publication audit completion failed", auditId: audit.id, requestId: context.get("requestId"), error: error instanceof Error ? error.message : String(error) }));
      }
      return context.json(success(publishedModelDto(published)), 201);
    } catch (error) {
      try {
        await finishPendingAudit(context, audit, "failure", { modelKey: key, compatibility: requestedCompatibility, errorCode: errorCode(error) });
      } catch (auditError) {
        console.error(JSON.stringify({ message: "Platform model publication failure audit completion failed", auditId: audit.id, requestId: context.get("requestId"), error: auditError instanceof Error ? auditError.message : String(auditError) }));
      }
      throw error;
    }
  });

  app.post("/api/v1/platform-admin/models/:modelKey/retire", async (context) => {
    const admin = await requirePlatformAdminContext(context, "models:manage");
    const key = modelKey(context.req.param("modelKey"));
    const audit = await beginPendingAudit(context, admin, "model.retire", "model", key, { modelKey: key });
    try {
      await retireModel(context.env, admin.executor, key);
      try {
        await finishPendingAudit(context, audit, "success", { modelKey: key });
      } catch (error) {
        console.error(JSON.stringify({ message: "Platform model retirement audit completion failed", auditId: audit.id, requestId: context.get("requestId"), error: error instanceof Error ? error.message : String(error) }));
      }
      return context.body(null, 204);
    } catch (error) {
      try {
        await finishPendingAudit(context, audit, "failure", { modelKey: key, errorCode: errorCode(error) });
      } catch (auditError) {
        console.error(JSON.stringify({ message: "Platform model retirement failure audit completion failed", auditId: audit.id, requestId: context.get("requestId"), error: auditError instanceof Error ? auditError.message : String(auditError) }));
      }
      throw error;
    }
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
