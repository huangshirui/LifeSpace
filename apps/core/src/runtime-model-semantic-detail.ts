import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import type { ModelAccess } from "./model-definition";
import { consumeSingleUseRead, requireModelAccess, type ModelAccessDecision } from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { projectModelSemanticFacts } from "./model-semantic-projection";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const accessOrder: ModelAccess[] = ["read", "write", "manage"];
const scopeForAccess: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};

function opaqueNotFound(): ApiError {
  return new ApiError("NOT_FOUND", "Resource not found", 404);
}

function lowestScopedDeclaredAccess(principal: Principal, model: PublishedModel): ModelAccess | null {
  return accessOrder.find((access) => model.definition.access.includes(access)
    && principal.scopes.includes(scopeForAccess[access])) ?? null;
}

async function requireCurrentVisibility(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  delegationId?: string | null,
): Promise<ModelAccessDecision> {
  const required = lowestScopedDeclaredAccess(principal, model);
  if (!required) throw opaqueNotFound();
  try {
    return await requireModelAccess(env, principal, spaceId, model, required, { delegationId });
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 405].includes(error.status)) throw opaqueNotFound();
    throw error;
  }
}

export function registerRuntimeModelSemanticDetailRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/_discovery/models/:modelKey", async (context) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");
    const model = await getRuntimeModel(context.env, context.req.param("modelKey"));
    if (!model) throw opaqueNotFound();

    const access = await requireCurrentVisibility(
      context.env,
      principal,
      spaceId,
      model,
      context.req.header("x-lifespace-delegation-id"),
    );
    const response = success(projectModelSemanticFacts(model));
    await consumeSingleUseRead(context.env, access);
    return context.json(response);
  });
}
