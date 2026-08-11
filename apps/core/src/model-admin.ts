import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
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
    route: model.route,
    version: model.version,
    state: model.state,
    schemaHash: model.schemaHash,
    compatibility: model.compatibility,
    definition: model.definition,
    publishedAt: model.publishedAt,
  };
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
    const published = await publishModelDefinition(context.env, principal, input.definition, compatibility(input.compatibility));
    return context.json(success(dto(published)), 201);
  });

  app.post("/api/v1/model-admin/models/:modelKey/retire", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    await retireModel(context.env, principal, context.req.param("modelKey"));
    return context.body(null, 204);
  });
}
