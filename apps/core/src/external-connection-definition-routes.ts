import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext } from "./platform-admin-auth";
import { getExternalModel } from "./external-model";
import { getRuntimeModel, listRuntimeModels } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AuthorityMode = "space-user" | "platform-admin";

async function authorize(c: Context<AppEnv>, mode: AuthorityMode) {
  if (mode === "platform-admin") {
    await requirePlatformAdminContext(c, "spaces:manage");
    return;
  }
  const principal = c.get("principal");
  if (principal.type !== "user" || principal.actor)
    throw new ApiError("FORBIDDEN", "Direct User management is required", 403);
  await requireSpacePermission(c.env, principal, c.req.param("spaceId")!, "manage");
}

function registerDefinitionRouteSet(app: App, base: string, mode: AuthorityMode): void {
  const definitionPath = `${base}/external-model-definitions`;
  const bindingPath = `${base}/external-models`;

  if (mode === "space-user") app.use(definitionPath, requireScope("spaces:manage"));
  app.get(definitionPath, async (c) => {
    await authorize(c, mode);
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

  // Enforce the published business-definition ceiling before Provider discovery
  // for both direct Space managers and Platform Admin governance clients.
  if (mode === "space-user") {
    app.use(bindingPath, requireScope("spaces:manage"));
    app.use(bindingPath + "/:modelKey", requireScope("spaces:manage"));
  }
  app.use(bindingPath, async (c, next) => {
    if (c.req.method !== "POST") return next();
    await authorize(c, mode);
    const input = await c.req.raw.clone().json<Record<string, unknown>>().catch(() => null);
    if (input?.declaredAccess !== "write" || typeof input.definitionKey !== "string") return next();
    const model = await getRuntimeModel(c.env, input.definitionKey);
    if (model?.definition.origin !== "external" || !model.definition.access.includes("write")) {
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "External Model Definition is unavailable or read-only", 422);
    }
    return next();
  });

  app.use(bindingPath + "/:modelKey", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    await authorize(c, mode);
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

export function registerExternalConnectionDefinitionRoutes(app: App) {
  registerDefinitionRouteSet(app, "/api/v1/spaces/:spaceId", "space-user");
  registerDefinitionRouteSet(app, "/api/v1/platform-admin/spaces/:spaceId", "platform-admin");
}
