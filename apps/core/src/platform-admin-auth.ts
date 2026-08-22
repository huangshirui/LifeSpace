import type { Context } from "hono";
import { verifyAccessToken } from "./auth";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };

export const PLATFORM_ADMIN_ACTOR_HEADER = "x-lifespace-actor-token";
export const PLATFORM_ADMIN_ACTOR_SCOPE = "platform:admin";

export type PlatformAdminContext = {
  actor: Principal & { type: "user" };
  executor: Principal & { type: "service" };
};

export async function requirePlatformAdminContext(
  context: Context<AppEnv>,
  executorScope: string,
): Promise<PlatformAdminContext> {
  const executor = context.get("principal");
  if (executor.type !== "service") {
    throw new ApiError("FORBIDDEN", "Platform administration requires a service principal executor", 403);
  }
  if (!executor.scopes.includes(executorScope)) {
    throw new ApiError("FORBIDDEN", `Scope ${executorScope} is required`, 403);
  }

  const rawActorToken = context.req.header(PLATFORM_ADMIN_ACTOR_HEADER)?.trim();
  if (!rawActorToken) {
    throw new ApiError("PLATFORM_ADMIN_ACTOR_REQUIRED", "Verified platform administrator actor proof is required", 401);
  }
  if (!context.env.IDENTITY_PUBLIC_KEY) {
    throw new ApiError("AUTHENTICATION_NOT_CONFIGURED", "Identity public verification key is not configured", 500);
  }

  let actor: Principal;
  try {
    actor = await verifyAccessToken(rawActorToken, context.env.IDENTITY_PUBLIC_KEY);
  } catch {
    throw new ApiError("PLATFORM_ADMIN_ACTOR_INVALID", "Platform administrator actor proof is invalid", 401);
  }
  if (actor.type !== "user" || !actor.scopes.includes(PLATFORM_ADMIN_ACTOR_SCOPE)) {
    throw new ApiError("FORBIDDEN", "Platform administrator actor authority is required", 403);
  }
  if (actor.clientId !== executor.clientId) {
    throw new ApiError("PLATFORM_ADMIN_ACTOR_MISMATCH", "Actor proof and executor must belong to the same LifeSpace application", 403);
  }

  return { actor: actor as Principal & { type: "user" }, executor: executor as Principal & { type: "service" } };
}
