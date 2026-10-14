import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { listRuntimeModels } from "./model-registry";

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
}
