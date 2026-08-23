import type { Context } from "hono";
import { verify } from "hono/jwt";
import type { Bindings, UserPrincipal, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };

export const PLATFORM_ADMIN_ACTOR_HEADER = "x-lifespace-actor-token";
export const PLATFORM_ADMIN_ACTOR_SCOPE = "platform:admin";
const MAX_ADMIN_ACTOR_TTL_SECONDS = 300;

type Failure = { error: { code: string; message: string; requestId: string } };

function fail(code: string, message: string, requestId: string): Failure {
  return { error: { code, message, requestId } };
}

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

export async function requirePlatformAdminActor(c: Context<AppEnv>, executorScope: string): Promise<UserPrincipal | Response> {
  if (!c.get("currentApplicationScopes").includes(executorScope)) {
    return c.json(fail("FORBIDDEN", `Scope ${executorScope} is required`, c.get("requestId")), 403);
  }

  const rawToken = c.req.header(PLATFORM_ADMIN_ACTOR_HEADER)?.trim();
  if (!rawToken) {
    return c.json(fail("PLATFORM_ADMIN_ACTOR_REQUIRED", "Verified platform administrator actor proof is required", c.get("requestId")), 401);
  }
  if (!c.env.TOKEN_PUBLIC_KEY) {
    return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token verification key is not configured", c.get("requestId")), 500);
  }

  let payload: Awaited<ReturnType<typeof verify>>;
  try {
    payload = await verify(rawToken, c.env.TOKEN_PUBLIC_KEY, "RS256");
  } catch {
    return c.json(fail("PLATFORM_ADMIN_ACTOR_INVALID", "Platform administrator actor proof is invalid", c.get("requestId")), 401);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  if (
    payload.iss !== "lifespace-identity"
    || !audienceIncludes(payload.aud, "lifespace-identity")
    || payload.principal_type !== "user"
    || payload.purpose !== "platform_admin_actor"
    || typeof payload.sub !== "string"
    || typeof payload.azp !== "string"
    || typeof payload.jti !== "string"
    || typeof payload.iat !== "number"
    || typeof payload.exp !== "number"
    || payload.iat > timestamp
    || payload.exp <= timestamp
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_ADMIN_ACTOR_TTL_SECONDS
  ) {
    return c.json(fail("PLATFORM_ADMIN_ACTOR_INVALID", "Platform administrator actor proof is invalid", c.get("requestId")), 401);
  }

  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes(PLATFORM_ADMIN_ACTOR_SCOPE)) {
    return c.json(fail("FORBIDDEN", "Platform administrator actor authority is required", c.get("requestId")), 403);
  }
  if (payload.azp !== c.get("currentApplicationId")) {
    return c.json(fail("PLATFORM_ADMIN_ACTOR_MISMATCH", "Actor proof and executor must belong to the same LifeSpace application", c.get("requestId")), 403);
  }

  const state = await c.env.DB.prepare(`SELECT u.status user_status,p.status admin_status
    FROM users u LEFT JOIN platform_administrators p ON p.user_id=u.id
    WHERE u.id=?`).bind(payload.sub).first<{ user_status: string; admin_status: string | null }>();
  if (!state || state.user_status !== "active") {
    return c.json(fail("FORBIDDEN", "Platform administrator actor is not active", c.get("requestId")), 403);
  }
  if (state.admin_status !== "active") {
    return c.json(fail("PLATFORM_ADMIN_NOT_ASSIGNED", "User is not an active LifeSpace platform administrator", c.get("requestId")), 403);
  }

  return { id: payload.sub, clientId: payload.azp, scopes, tokenId: payload.jti };
}
