import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { getOrCreateActiveModelContract, readModelContract } from "./model-contract-service";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";
import {
  getPublishedModel,
  listPublishedModels,
  publishModelDefinition,
  retireModel,
  validateDefinition,
  type ModelCompatibility,
} from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type PendingAudit = { id: string; admin: PlatformAdminContext };

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

function requireService(principal: Principal): void {
  if (principal.type !== "service") {
    throw new ApiError("FORBIDDEN", "Model administration requires a service principal", 403);
  }
}

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  return value as Body;
}

function compatibility(value: unknown): ModelCompatibility {
  if (value !== "initial" && value !== "compatible" && value !== "breaking") {
    throw new ApiError("INVALID_REQUEST", "compatibility must be initial, compatible, or breaking", 400);
  }
  return value;
}

function dto(model: Awaited<ReturnType<typeof getPublishedModel>>) {
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

function modelKeyFromDefinition(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const key = (value as Record<string, unknown>).key;
    if (typeof key === "string" && key.trim()) return key.trim().slice(0, 100);
  }
  return "unresolved";
}

async function beginConsoleMutationAudit(
  context: Context<AppEnv>,
  operation: string,
  modelKey: string,
  summary: unknown,
): Promise<PendingAudit | null> {
  if (!context.req.header("x-lifespace-actor-token")?.trim()) return null;
  const admin = await requirePlatformAdminContext(context, "models:manage");
  const auditId = createId("paa");
  await context.env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    auditId,
    admin.actor.id,
    admin.actor.clientId,
    admin.actor.tokenId,
    admin.executor.id,
    admin.executor.clientId,
    admin.executor.tokenId,
    operation,
    "model",
    modelKey,
    JSON.stringify(summary),
    context.get("requestId"),
    "pending",
    now(),
  ).run();
  return { id: auditId, admin };
}

async function finishConsoleMutationAudit(
  context: Context<AppEnv>,
  audit: PendingAudit | null,
  result: "success" | "failure",
  summary: unknown,
): Promise<void> {
  if (!audit) return;
  await context.env.DB.prepare("UPDATE platform_admin_audit SET result=?,summary_json=? WHERE id=? AND result='pending'")
    .bind(result, JSON.stringify(summary), audit.id).run();
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "INTERNAL_ERROR";
}

export function registerModelAdminRoutes(app: App): void {
  app.get("/api/v1/model-admin/models", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    const models = await listPublishedModels(context.env);
    return context.json(success(models.map((model) => dto(model))));
  });

  app.get("/api/v1/model-admin/models/:modelKey", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    const model = await getPublishedModel(context.env, context.req.param("modelKey"));
    if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
    return context.json(success(dto(model)));
  });

  app.post("/api/v1/model-admin/models/validate", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "definition") || input.definition === undefined) {
      throw new ApiError("INVALID_REQUEST", "Request must contain only definition", 400);
    }
    const validation = await validateDefinition(input.definition);
    return context.json(success(validation));
  });

  app.post("/api/v1/model-admin/models", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "definition" && key !== "compatibility") || input.definition === undefined) {
      throw new ApiError("INVALID_REQUEST", "Request must contain definition and compatibility", 400);
    }
    const requestedCompatibility = compatibility(input.compatibility);
    const modelKey = modelKeyFromDefinition(input.definition);
    const audit = await beginConsoleMutationAudit(context, "model.publish", modelKey, {
      modelKey,
      compatibility: requestedCompatibility,
    });
    try {
      const published = await publishModelDefinition(context.env, principal, input.definition, requestedCompatibility);
      try {
        await finishConsoleMutationAudit(context, audit, "success", {
          modelKey: published.key,
          version: published.version,
          schemaHash: published.schemaHash,
          compatibility: published.compatibility,
        });
      } catch (error) {
        console.error(JSON.stringify({ message: "Model publication audit completion failed", auditId: audit?.id, requestId: context.get("requestId"), error: error instanceof Error ? error.message : String(error) }));
      }
      return context.json(success(dto(published)), 201);
    } catch (error) {
      try {
        await finishConsoleMutationAudit(context, audit, "failure", { modelKey, compatibility: requestedCompatibility, errorCode: errorCode(error) });
      } catch (auditError) {
        console.error(JSON.stringify({ message: "Model publication failure audit completion failed", auditId: audit?.id, requestId: context.get("requestId"), error: auditError instanceof Error ? auditError.message : String(auditError) }));
      }
      throw error;
    }
  });

  app.post("/api/v1/model-admin/models/:modelKey/retire", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    const modelKey = context.req.param("modelKey");
    const audit = await beginConsoleMutationAudit(context, "model.retire", modelKey, { modelKey });
    try {
      await retireModel(context.env, principal, modelKey);
      try {
        await finishConsoleMutationAudit(context, audit, "success", { modelKey });
      } catch (error) {
        console.error(JSON.stringify({ message: "Model retirement audit completion failed", auditId: audit?.id, requestId: context.get("requestId"), error: error instanceof Error ? error.message : String(error) }));
      }
      return context.body(null, 204);
    } catch (error) {
      try {
        await finishConsoleMutationAudit(context, audit, "failure", { modelKey, errorCode: errorCode(error) });
      } catch (auditError) {
        console.error(JSON.stringify({ message: "Model retirement failure audit completion failed", auditId: audit?.id, requestId: context.get("requestId"), error: auditError instanceof Error ? auditError.message : String(auditError) }));
      }
      throw error;
    }
  });

  app.get("/api/v1/model-admin/contracts/active", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    return context.json(success(await getOrCreateActiveModelContract(context.env)));
  });

  app.get("/api/v1/model-admin/contracts/:contractId", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    const contractId = context.req.param("contractId");
    if (!/^mct_[a-f0-9]{64}$/u.test(contractId)) throw new ApiError("MODEL_CONTRACT_NOT_FOUND", "Model contract revision not found", 404);
    return context.json(success(await readModelContract(context.env, contractId)));
  });
}
