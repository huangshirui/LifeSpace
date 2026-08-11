import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const MAX_ACCESS_TOKEN_TTL_SECONDS = 3600;

function unauthorized(): ApiError {
  return new ApiError("UNAUTHORIZED", "Authentication is required", 401);
}

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

export async function verifyAccessToken(rawToken: string, publicKey: string): Promise<Principal> {
  try {
    const payload = await verify(rawToken, publicKey, "RS256");
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== "lifespace-identity" || !audienceIncludes(payload.aud, "lifespace-core")) throw unauthorized();
    if (typeof payload.sub !== "string" || !payload.sub) throw unauthorized();
    if (typeof payload.azp !== "string" || !payload.azp) throw unauthorized();
    if (typeof payload.jti !== "string" || !payload.jti) throw unauthorized();
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now || payload.exp <= now || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_ACCESS_TOKEN_TTL_SECONDS) throw unauthorized();
    if (payload.principal_type !== "user" && payload.principal_type !== "service" && payload.principal_type !== "device") throw unauthorized();
    const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
    return { type: payload.principal_type, id: payload.sub, clientId: payload.azp, scopes, tokenId: payload.jti };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unauthorized();
  }
}

export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    if (!authorization?.startsWith("Bearer ") || !context.env.IDENTITY_PUBLIC_KEY) throw unauthorized();
    const principal = await verifyAccessToken(authorization.slice(7), context.env.IDENTITY_PUBLIC_KEY);
    context.set("principal", principal);
    await next();
  };
}

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (!context.get("principal").scopes.includes(scope)) throw new ApiError("FORBIDDEN", `Scope ${scope} is required`, 403);
    await next();
  };
}
