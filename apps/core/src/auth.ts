import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { isPrincipalType, type Bindings, type Principal, type Variables } from "./env";
import { ApiError } from "./http";
import { servicePrincipalAuthority } from "./service-principal-authority";
import { measurePerformancePhase } from "./performance-timing";
import { currentMcpOAuthQueryPolicy, oauthMcpServerId } from "./mcp-oauth-server-policy";
import { requireOAuthMcpDelegatedOperation } from "./oauth-delegation-routes";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const MAX_ACCESS_TOKEN_TTL_SECONDS = 3600;
const SERVICE_TOKEN_PREFIXES = ["lsp_svc_", "lsp_pat_"] as const;
const AGENT_API_TOKEN_PREFIX = "lsp_agt_";
const MAX_OAUTH_EXECUTION_TTL_SECONDS = 60;

export function oauthExecutionRouteAllowed(method: string, path: string, spaceId: string, write = false): boolean {
  if (method === "GET" && path === "/api/v1/me/_discovery/inventory") return true;
  // Only the distinct OAuth transport may create/read an arq_*; trusted
  // /authorization-requests confirm/deny routes remain inaccessible.
  const root = "/api/v1/spaces/" + spaceId + "/oauth-delegation-requests";
  if (method === "POST" && path === root) return true;
  if (method === "GET" && path.startsWith(root + "/")
    && /^arq_[a-f0-9]{32}$/u.test(path.slice(root.length + 1))) return true;
  if (!/^spc_[A-Za-z0-9_-]+$/u.test(spaceId)) return false;
  // spaceId is validated against an ASCII-only identifier grammar above.
  const escaped = spaceId;
  if (method === "GET") {
    return path === "/api/v1/spaces/" + escaped + "/_discovery/operations"
      || new RegExp("^/api/v1/spaces/" + escaped + "/people(?:/per_[A-Za-z0-9_-]+)?$", "u").test(path)
      || new RegExp("^/api/v1/spaces/" + escaped + "/_discovery/models/[a-z][a-z0-9_-]{0,63}$", "u").test(path)
      || new RegExp("^/api/v1/spaces/" + escaped + "/models/[a-z][a-z0-9_]{1,62}/records/rec_[A-Za-z0-9_-]+$", "u").test(path);
  }
  if (write && new RegExp("^/api/v1/spaces/" + escaped + "/people(?:/per_[A-Za-z0-9_-]+)?$", "u").test(path)) {
    return method === "POST" && path.endsWith("/people")
      || (method === "PATCH" || method === "DELETE") && !path.endsWith("/people");
  }
  if (write && new RegExp("^/api/v1/spaces/" + escaped + "/models/[a-z][a-z0-9_-]{0,63}/records(?:/rec_[A-Za-z0-9_-]+)?$", "u").test(path)) {
    return method === "POST" && path.endsWith("/records")
      || (method === "PATCH" || method === "DELETE") && !path.endsWith("/records");
  }
  if (method === "POST") {
    if (path === "/api/v1/spaces/" + escaped + "/_discovery/models/batch") return true;
    if (new RegExp("^/api/v1/spaces/" + escaped + "/_operations/op_[a-f0-9]{64}/invoke$", "u").test(path)) return true;
    if (new RegExp("^/api/v1/spaces/" + escaped + "/models/[a-z][a-z0-9_]{1,62}/records/rec_[A-Za-z0-9_-]+/actions/[a-z][a-z0-9_-]{0,62}$", "u").test(path)) return true;
    return new RegExp("^/api/v1/spaces/" + escaped + "/models/[a-z][a-z0-9_-]{0,63}/records/query$", "u").test(path);
  }
  return false;
}

async function requireCurrentOAuthExecution(env: Bindings, execution: NonNullable<Principal["oauthExecution"]>, scopes: string[]) {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) throw notConfigured("OAuth Core introspection binding is not configured");
  let response: Response;
  try {
    response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/oauth-executions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET,
      },
      body: JSON.stringify({
        authorizationId: execution.authorizationId,
        tokenHash: execution.accessHash,
        clientId: execution.clientId,
        resource: execution.resource,
        applicationId: execution.applicationId,
        agentId: execution.agentId,
        spaceId: execution.spaceId,
      }),
    });
  } catch { throw unauthorized(); }
  const payload = response.ok ? await response.json<{ data?: { active?: boolean; scopes?: string[];
    userId?: string; allowUserAuthorization?: boolean } }>().catch(() => null) : null;
  if (payload?.data?.active !== true) throw unauthorized();
  // Legacy introspection may only validate read. Write requires live consent evidence.
  const current = payload.data.scopes ?? ["resources:read"];
  if (!Array.isArray(current) || current.some(scope => typeof scope !== "string")
    || scopes.some(scope => !current.includes(scope))
    || payload?.data?.userId !== execution.userId
    || payload?.data?.allowUserAuthorization !== execution.allowUserAuthorization) throw unauthorized();
}


export function isOpaqueServiceApiToken(value: string): boolean {
  return SERVICE_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function isOpaqueAgentApiCredential(value: string): boolean {
  return value.startsWith(AGENT_API_TOKEN_PREFIX);
}

function unauthorized(): ApiError {
  return new ApiError("UNAUTHORIZED", "Authentication is required", 401);
}

function notConfigured(message: string): ApiError {
  return new ApiError("AUTHENTICATION_NOT_CONFIGURED", message, 500);
}

function validOAuthClientIdentifier(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 256) return false;
  if (/^ocli_[A-Za-z0-9_-]+$/u.test(value)) return true;
  // Identity verified the public metadata; Core only validates the signed
  // identifier's shape and subsequently rechecks Identity's current state.
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === value
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname !== "/" && url.hostname.includes(".")
      && !url.hostname.includes("*");
  } catch { return false; }
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

    const oauthKeysPresent = Object.keys(payload).some(key => key.startsWith("oauth_"));
    const isOAuthExecution = payload.purpose === "oauth_agent_execution";
    const hasAgentExecutionClaims = payload.actor_type !== undefined
      || payload.actor_id !== undefined
      || payload.principal_id !== undefined
      || payload.purpose === "agent_execution"
      || isOAuthExecution || oauthKeysPresent;
    if (hasAgentExecutionClaims) {
      if (
        (payload.purpose !== "agent_execution" && !isOAuthExecution)
        || payload.actor_type !== "agent"
        || typeof payload.actor_id !== "string"
        || !/^agt_[A-Za-z0-9_-]+$/u.test(payload.actor_id)
        || payload.sub !== payload.actor_id
        || typeof payload.principal_id !== "string"
        || !payload.principal_id
      ) throw unauthorized();

      // Agent execution currently has two complete Identity/Authority profiles:
      // direct Agent authority and User authority represented by an Agent. Service
      // and Device remain ordinary Principal types but are not accepted here until
      // their Agent-delegation issuance/identity lifecycle is deliberately enabled.
      const principalId = payload.principal_id;
      if (payload.principal_type === "user") {
        if (!/^usr_[A-Za-z0-9_-]+$/u.test(principalId)) throw unauthorized();
      } else if (payload.principal_type === "agent") {
        if (!/^agt_[A-Za-z0-9_-]+$/u.test(principalId)) throw unauthorized();
      } else {
        throw unauthorized();
      }

      const directAgent = payload.principal_type === "agent" && principalId === payload.actor_id;
      const representedOAuthUser = isOAuthExecution && payload.principal_type === "user"
        && principalId === payload.oauth_user_id && payload.oauth_allow_user_authorization === true
        && typeof payload.oauth_delegation_id === "string"
        && /^dlg_[A-Za-z0-9_-]+$/u.test(payload.oauth_delegation_id);
      if (isOAuthExecution) {
        if ((!directAgent && !representedOAuthUser)
          || (directAgent && payload.oauth_delegation_id !== undefined)
          || typeof payload.scope !== "string"
          || !["resources:read", "resources:read resources:write"].includes(payload.scope)
          || payload.exp - payload.iat > MAX_OAUTH_EXECUTION_TTL_SECONDS
          || typeof payload.oauth_authorization_id !== "string"
          || !/^oaz_[A-Za-z0-9_-]{10,128}$/u.test(payload.oauth_authorization_id)
          || typeof payload.oauth_access_hash !== "string"
          || !/^[a-f0-9]{64}$/u.test(payload.oauth_access_hash)
          || typeof payload.oauth_client_id !== "string"
          || !validOAuthClientIdentifier(payload.oauth_client_id)
          || typeof payload.oauth_space_id !== "string"
          || !/^spc_[A-Za-z0-9_-]+$/u.test(payload.oauth_space_id)
          || typeof payload.oauth_resource !== "string"
          || !oauthMcpServerId(payload.oauth_resource)
          || typeof payload.oauth_user_id !== "string"
          || !/^usr_[A-Za-z0-9_-]+$/u.test(payload.oauth_user_id)
          || typeof payload.oauth_allow_user_authorization !== "boolean") throw unauthorized();
      } else if (oauthKeysPresent) {
        // A normal Agent JWT must never smuggle OAuth restrictions or purpose.
        throw unauthorized();
      }
      return {
        type: payload.principal_type,
        id: principalId,
        clientId: payload.azp,
        scopes,
        tokenId: payload.jti,
        ...(directAgent ? {} : { actor: { type: "agent" as const, id: payload.actor_id } }),
        purpose: isOAuthExecution ? "oauth_agent_execution" : "agent_execution",
        ...(isOAuthExecution ? { oauthExecution: {
          authorizationId: payload.oauth_authorization_id as string,
          accessHash: payload.oauth_access_hash as string,
          clientId: payload.oauth_client_id as string,
          resource: payload.oauth_resource as string,
          spaceId: payload.oauth_space_id as string,
          applicationId: payload.azp,
          agentId: payload.actor_id,
          userId: payload.oauth_user_id as string,
          allowUserAuthorization: payload.oauth_allow_user_authorization as boolean,
          ...(representedOAuthUser ? { delegationId: payload.oauth_delegation_id as string } : {}),
        } } : {}),
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


export async function introspectAgentCredential(rawToken: string, env: Bindings): Promise<Principal> {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw notConfigured("Identity Agent credential introspection binding is not configured");
  }
  let response: Response;
  try {
    response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/agent-credentials", {
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
    || principal.type !== "agent"
    || !/^agt_[A-Za-z0-9_-]+$/u.test(principal.id)
    || typeof principal.clientId !== "string"
    || typeof principal.tokenId !== "string"
    || !Array.isArray(principal.scopes)
    || principal.scopes.some((scope) => typeof scope !== "string")
    || principal.purpose !== "agent_api"
    || principal.actor !== undefined
  ) throw unauthorized();
  return {
    type: "agent",
    id: principal.id,
    ...(typeof principal.displayName === "string" && principal.displayName.trim()
      ? { displayName: principal.displayName.trim() }
      : {}),
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    tokenId: principal.tokenId,
    purpose: "agent_api",
  };
}

export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) throw unauthorized();
    const rawToken = authorization.slice(7).trim();
    if (!rawToken) throw unauthorized();

    let principal: Principal;
    if (isOpaqueServiceApiToken(rawToken)) {
      principal = await measurePerformancePhase(
        context,
        "security.service_token_check",
        () => introspectServiceToken(rawToken, context.env),
      );
    } else if (isOpaqueAgentApiCredential(rawToken)) {
      principal = await measurePerformancePhase(
        context,
        "security.agent_credential_check",
        () => introspectAgentCredential(rawToken, context.env),
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

    if (principal.purpose === "oauth_agent_execution") {
      const execution = principal.oauthExecution;
      if (!execution || !oauthExecutionRouteAllowed(context.req.method, context.req.path, execution.spaceId,
        principal.scopes.includes("resources:write"))) {
        throw new ApiError("FORBIDDEN", "OAuth Agent execution is limited to its selected Space and enabled model operation surface", 403);
      }
      await measurePerformancePhase(context, "security.oauth_execution_state",
        () => requireCurrentOAuthExecution(context.env, execution, principal.scopes));
      const oauthRequestPath = "/api/v1/spaces/" + execution.spaceId + "/oauth-delegation-requests";
      const isApprovalTransport = context.req.path === oauthRequestPath ||
        (context.req.path.startsWith(oauthRequestPath + "/") &&
          /^arq_[a-f0-9]{32}$/u.test(context.req.path.slice(oauthRequestPath.length + 1)));
      if (isApprovalTransport) {
        if (principal.type !== "agent" || !execution.allowUserAuthorization)
          throw new ApiError("FORBIDDEN", "Explicit User Delegation is disabled", 403);
        // The route itself validates current Server operations and OAuth Scope.
        context.set("principal", principal);
        await next();
        return;
      }
      if (principal.actor) {
        const delegated = context.req.header("x-lifespace-delegation-id");
        if (!execution.delegationId || delegated !== execution.delegationId)
          throw new ApiError("FORBIDDEN", "Signed OAuth Delegation selector is required", 403);
        await measurePerformancePhase(context, "security.oauth_delegation_operation",
          () => requireOAuthMcpDelegatedOperation(
            context.env, principal, context.req.method, context.req.path, delegated,
          ));
      } else if (context.req.header("x-lifespace-delegation-id")) {
        throw new ApiError("FORBIDDEN", "Direct OAuth execution cannot select Delegation", 403);
      }
      const policy = await measurePerformancePhase(context, "security.oauth_server_policy",
        () => currentMcpOAuthQueryPolicy(
          context.env.DB, execution.resource, context.req.method, context.req.path,
        ));
      principal = { ...principal, oauthExecution: {
        ...execution, serverId: policy.serverId, queryModelKeys: policy.queryModelKeys,
        toolModelKeys: policy.toolModelKeys, modelOperations: policy.modelOperations,
        personOperations: policy.personOperations,
      } };
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
