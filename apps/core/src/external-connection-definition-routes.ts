import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { getExternalModel } from "./external-model";
import { getRuntimeModel, listRuntimeModels } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

async function manager(c: Context<AppEnv>) {
  const principal = c.get("principal");
  if (principal.type !== "user" || principal.actor)
    throw new ApiError("FORBIDDEN", "Direct User management is required", 403);
  await requireSpacePermission(c.env, principal, c.req.param("spaceId")!, "manage");
}

export function registerExternalConnectionDefinitionRoutes(app: App) {
  const path = "/api/v1/spaces/:spaceId/external-model-definitions";
  app.use(path, requireScope("spaces:manage"));
  app.get(path, async (c) => {
    await manager(c);
    const models = await listRuntimeModels(c.env);
    const items = models
      .filter((model) => model.definition.origin === "external")
      .map((model) => ({
        key: model.key,
        displayName: model.definition.display.singular,
        description: model.definition.description ?? null,
        access: model.definition.access,
        schemaHash: model.schemaHash,
      }));
    return c.json(success({ items }));
  });

  // Binding is a Space-management operation. Enforce the business-definition
  // access ceiling before Provider discovery so a direct API client cannot bind
  // a read-only External definition as write merely by bypassing Console UX.
  const bindingPath = "/api/v1/spaces/:spaceId/external-models";
  app.use(bindingPath, requireScope("spaces:manage"), async (c, next) => {
    if (c.req.method !== "POST") return next();
    await manager(c);
    const input = await c.req.raw.clone().json<Record<string, unknown>>().catch(() => null);
    if (input?.declaredAccess !== "write" || typeof input.definitionKey !== "string") return next();
    const model = await getRuntimeModel(c.env, input.definitionKey);
    if (model?.definition.origin !== "external" || !model.definition.access.includes("write")) {
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "External Model Definition is unavailable or read-only", 422);
    }
    return next();
  });

  // The same business-definition ceiling applies when a direct API client raises
  // an existing binding from read to write. Legacy registration-only rows without
  // definition_key retain their historical behavior; product bindings fail closed
  // if their published External definition has disappeared or no longer permits write.
  app.use(bindingPath + "/:modelKey", requireScope("spaces:manage"), async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    await manager(c);
    const input = await c.req.raw.clone().json<Record<string, unknown>>().catch(() => null);
    if (input?.declaredAccess !== "write") return next();
    const binding = await getExternalModel(c.env, c.req.param("spaceId")!, c.req.param("modelKey")!, true);
    if (
      binding?.definition_key &&
      (!binding.businessDefinition ||
        binding.businessDefinition.definition.origin !== "external" ||
        !binding.businessDefinition.definition.access.includes("write"))
    ) {
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "External Model Definition is unavailable or read-only", 422);
    }
    return next();
  });
}
