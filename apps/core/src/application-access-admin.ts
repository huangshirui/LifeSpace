import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { listPublishedModels } from "./model-registry";
import type { ModelAccess } from "./model-definition";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AccessEntry = { modelKey: string; maxAccess: ModelAccess };

function requireService(principal: Principal): void {
  if (principal.type !== "service") {
    throw new ApiError("FORBIDDEN", "Application model-access administration requires a service principal", 403);
  }
}

async function parseEntries(context: Context<AppEnv>): Promise<AccessEntry[]> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "models") || !Array.isArray(body.models)) {
    throw new ApiError("INVALID_REQUEST", "Request must contain only a models array", 400);
  }

  const entries: AccessEntry[] = [];
  const seen = new Set<string>();
  for (const raw of body.models) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError("VALIDATION_ERROR", "Each model access entry must be an object", 422);
    }
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "modelKey" && key !== "maxAccess")) {
      throw new ApiError("VALIDATION_ERROR", "Model access entries may contain only modelKey and maxAccess", 422);
    }
    if (typeof entry.modelKey !== "string" || !/^[a-z][a-z0-9_]{1,62}$/u.test(entry.modelKey)) {
      throw new ApiError("VALIDATION_ERROR", "modelKey is invalid", 422);
    }
    if (entry.maxAccess !== "read" && entry.maxAccess !== "write" && entry.maxAccess !== "manage") {
      throw new ApiError("VALIDATION_ERROR", "maxAccess must be read, write, or manage", 422);
    }
    if (seen.has(entry.modelKey)) {
      throw new ApiError("VALIDATION_ERROR", `Duplicate model access entry ${entry.modelKey}`, 422);
    }
    seen.add(entry.modelKey);
    entries.push({ modelKey: entry.modelKey, maxAccess: entry.maxAccess });
  }
  return entries;
}

function applicationId(context: Context<AppEnv>): string {
  const value = context.req.param("applicationId").trim();
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "applicationId is invalid", 422);
  }
  return value;
}

async function validateAgainstRegistry(env: Bindings, entries: AccessEntry[]): Promise<void> {
  const published = await listPublishedModels(env);
  const models = new Map(published.map((model) => [model.key, model]));
  for (const entry of entries) {
    const model = models.get(entry.modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${entry.modelKey} not found`, 404);
    if (!model.definition.access.includes(entry.maxAccess)) {
      throw new ApiError(
        "MODEL_ACCESS_UNSUPPORTED",
        `Model ${entry.modelKey} does not expose ${entry.maxAccess} access`,
        422,
      );
    }
  }
}

export function registerApplicationAccessAdminRoutes(app: App): void {
  app.get(
    "/internal/v1/application-model-access/:applicationId",
    requireScope("models:manage"),
    async (context) => {
      requireService(context.get("principal"));
      const id = applicationId(context);
      const rows = await context.env.DB.prepare(`
        SELECT model_key modelKey,max_access maxAccess,created_by_type createdByType,created_by_id createdById,created_at createdAt,updated_at updatedAt
        FROM application_model_access WHERE application_id=? ORDER BY model_key
      `).bind(id).all<{
        modelKey: string;
        maxAccess: ModelAccess;
        createdByType: string;
        createdById: string;
        createdAt: string;
        updatedAt: string;
      }>();
      return context.json(success({ applicationId: id, models: rows.results }));
    },
  );

  app.put(
    "/internal/v1/application-model-access/:applicationId",
    requireScope("models:manage"),
    async (context) => {
      const principal = context.get("principal");
      requireService(principal);
      const id = applicationId(context);
      const entries = await parseEntries(context);
      await validateAgainstRegistry(context.env, entries);

      const timestamp = new Date().toISOString();
      const statements = [
        context.env.DB.prepare("DELETE FROM application_model_access WHERE application_id=?").bind(id),
        ...entries.map((entry) => context.env.DB.prepare(`
          INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
        `).bind(id, entry.modelKey, entry.maxAccess, principal.type, principal.id, timestamp, timestamp)),
      ];
      await context.env.DB.batch(statements);
      return context.json(success({ applicationId: id, models: entries }));
    },
  );
}
