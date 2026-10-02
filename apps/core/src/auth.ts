import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { isPrincipalType, type Bindings, type Principal, type Variables } from "./env";
import { ApiError } from "./http";
import { servicePrincipalAuthority } from "./service-principal-authority";
import { measurePerformancePhase } from "./performance-timing";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const MAX_ACCESS_TOKEN_TTL_SECONDS = 3600;
const SERVICE_TOKEN_PREFIX = "lsp_pat_";

function unauthorized(): ApiError {
  return new ApiError("UNAUTHORIZED", "Authentication is required", 401);
}

function notConfigured(message: string): ApiError {
  return new ApiError("AUTHENTICATION_NOT_CONFIGURED", message, 500);
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
    if (!isPrincipalType(payload.principal_type)) throw unauthorized();
    const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];

    const hasAgentExecutionClaims = payload.actor_type !== undefined
      || payload.actor_id !== undefined
      || payload.principal_id !== undefined
      || payload.purpose === "delegated_agent"
      || payload.purpose === "agent_execution";
    if (hasAgentExecutionClaims) {
      if (
        payload.actor_type !== "agent"
        || typeof payload.actor_id !== "string"
        || !/^agt_[A-Za-z0-9]+$/.test(payload.actor_id)
      ) throw unauthorized();

      // Backwards-compatible Authority v2 credential profile.
      if (payload.purpose === "delegated_agent") {
        if (payload.principal_type !== "user" || !/^usr_[A-Za-z0-9_-]+$/.test(payload.sub)) throw unauthorized();
        return {
          type: "user",
          id: payload.sub,
          clientId: payload.azp,
          scopes,
          tokenId: payload.jti,
          actor: { type: "agent", id: payload.actor_id },
          purpose: "delegated_agent",
        };
      }

      // Generalized Agent Execution Token: sub authenticates the actual Agent
      // Actor while Principal is an independent signed operation-role claim.
      if (
        payload.purpose !== "agent_execution"
        || payload.sub !== payload.actor_id
        || typeof payload.principal_id !== "string"
        || !payload.principal_id
      ) throw unauthorized();

      const principalId = payload.principal_id;
      if (payload.principal_type === "user" && !/^usr_[A-Za-z0-9_-]+$/.test(principalId)) throw unauthorized();
      if (payload.principal_type === "agent" && !/^agt_[A-Za-z0-9_-]+$/.test(principalId)) throw unauthorized();
      if (payload.principal_type === "service" && !/^svc_[A-Za-z0-9_-]+$/.test(principalId)) throw unauthorized();
      if (payload.principal_type === "device" && !/^dev_[A-Za-z0-9_-]+$/.test(principalId)) throw unauthorized();

      const directAgent = payload.principal_type === "agent" && principalId === payload.actor_id;
      return {
        type: payload.principal_type,
        id: principalId,
        clientId: payload.azp,
        scopes,
        tokenId: payload.jti,
        ...(directAgent ? {} : { actor: { type: "agent" as const, id: payload.actor_id } }),
        purpose: "agent_execution",
      };
    }

    return { type: payload.principal_type, id: payload.sub, clientId: payload.azp, scopes, tokenId: payload.jti };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unauthorized();
  }
}

async function requireCurrentServicePrincipal(env: Bindings, principalId: string): Promise<string | undefined> {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw notConfigured("Identity service principal introspection binding is not configured");
  }
  try {
    const authority = await servicePrincipalAuthority(env, principalId);
    if (!authority.active) throw unauthorized();
    return authority.displayName;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unauthorized();
  }
}

export async function introspectServiceToken(rawToken: string, env: Bindings): Promise<Principal> {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw notConfigured("Identity introspection binding is not configured");
  }
  let response: Response;
  try {
    response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/service-tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawToken}`,
        "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET,
      },
    });
  } catch {
    throw unauthorized();
  }
  if (!response.ok) throw unauthorized();
  const payload = await response.json<{ data?: { active?: boolean; principal?: Principal; audience?: string } }>().catch(() => null);
  const principal = payload?.data?.principal;
  if (
    payload?.data?.active !== true
    || payload.data.audience !== "lifespace-core"
    || !principal
    || principal.type !== "service"
    || typeof principal.id !== "string"
    || (principal.displayName !== undefined && (typeof principal.displayName !== "string" || !principal.displayName.trim()))
    || typeof principal.clientId !== "string"
    || typeof principal.tokenId !== "string"
    || !Array.isArray(principal.scopes)
    || principal.scopes.some((scope) => typeof scope !== "string")
  ) throw unauthorized();
  return {
    type: "service",
    id: principal.id,
    ...(typeof principal.displayName === "string" && principal.displayName.trim()
      ? { displayName: principal.displayName.trim() }
      : {}),
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    tokenId: principal.tokenId,
  };
}

export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) throw unauthorized();
    const rawToken = authorization.slice(7).trim();
    if (!rawToken) throw unauthorized();

    let principal: Principal;
    if (rawToken.startsWith(SERVICE_TOKEN_PREFIX)) {
      principal = await measurePerformancePhase(
        context,
        "security.service_token_check",
        () => introspectServiceToken(rawToken, context.env),
      );
    } else if (context.env.IDENTITY_PUBLIC_KEY) {
      principal = await measurePerformancePhase(
        context,
        "security.jwt_check",
        () => verifyAccessToken(rawToken, context.env.IDENTITY_PUBLIC_KEY),
      );
      if (principal.type === "service") {
        const displayName = await measurePerformancePhase(
          context,
          "security.service_principal_state",
          () => requireCurrentServicePrincipal(context.env, principal.id),
        );
        principal = { ...principal, ...(displayName ? { displayName } : {}) };
      }
    } else {
      throw notConfigured("Identity public verification key is not configured");
    }

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
