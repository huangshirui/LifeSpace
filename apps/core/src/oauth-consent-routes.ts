import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import { ApiError, success } from "./http";
import { listPublishedModels } from "./model-registry";
import { visibleModelAccess } from "./runtime-discovery";
import type { ModelAccess } from "./model-definition";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type ConsentInput = {
  applicationId: string;
  spaceId: string;
  agentId: string;
  allowUserAuthorization: boolean;
};
const OAUTH_REQUEST_ID = /^oar_[A-Za-z0-9_-]{16,128}$/u;
const SPACE_ID = /^spc_[A-Za-z0-9_-]+$/u;
const AGENT_ID = /^agt_[A-Za-z0-9_-]+$/u;
const safeApplication = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/u.test(value);

function parseConsent(body: unknown): ConsentInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST", "OAuth consent selection must be an object", 400);
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) =>
    !["applicationId", "spaceId", "agentId", "allowUserAuthorization"].includes(key))
    || !safeApplication(input.applicationId)
    || typeof input.spaceId !== "string" || !SPACE_ID.test(input.spaceId)
    || typeof input.agentId !== "string" || !AGENT_ID.test(input.agentId)
    || typeof input.allowUserAuthorization !== "boolean") {
    throw new ApiError("INVALID_REQUEST", "Invalid OAuth consent selection", 400);
  }
  return input as ConsentInput;
}

type AgentCandidate = { agentId: string; agentName: string; applicationId: string; applicationName: string };

async function resolveAgentContexts(env: Bindings, agentIds: string[]): Promise<AgentCandidate[]> {
  if (!agentIds.length) return [];
  if (agentIds.length > 30) throw new ApiError("INVALID_REQUEST", "Too many Agent contexts", 400);
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw new ApiError("OAUTH_NOT_CONFIGURED", "Identity Agent context is unavailable", 503);
  }
  let result: Response;
  try {
    result = await env.IDENTITY.fetch("https://identity.internal/oauth/core/agent-candidates", {
      method: "POST",
      headers: { "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ agentIds }),
    });
  } catch {
    throw new ApiError("OAUTH_IDENTITY_UNAVAILABLE", "Identity Agent context is unavailable", 503);
  }
  if (!result.ok) throw new ApiError("OAUTH_IDENTITY_UNAVAILABLE", "Identity Agent context was rejected", 503);
  const payload = await result.json<unknown>().catch(() => null);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity Agent context", 502);
  }
  const allowedIds = new Set(agentIds);
  const data = (payload as { data: unknown[] }).data;
  if (data.length > 60 || data.some((item) => !item || typeof item !== "object"
    || typeof (item as AgentCandidate).agentId !== "string" || !allowedIds.has((item as AgentCandidate).agentId)
    || typeof (item as AgentCandidate).applicationId !== "string"
    || typeof (item as AgentCandidate).agentName !== "string"
    || typeof (item as AgentCandidate).applicationName !== "string")) {
    throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity Agent context", 502);
  }
  return data as AgentCandidate[];
}

async function candidates(env: Bindings, spaceId: string): Promise<AgentCandidate[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT g.grantee_id agentId FROM data_grants g " +
    "JOIN spaces s ON s.id=g.source_space_id AND s.deleted_at IS NULL " +
    "WHERE g.source_space_id=? AND g.grantee_type='agent' " +
    "AND g.resource_type IN ('space','model') AND g.permission IN ('read','write','manage') " +
    "AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now')) " +
    "ORDER BY g.grantee_id LIMIT 30"
  ).bind(spaceId).all<{ agentId: string }>();
  return resolveAgentContexts(env, rows.results.map((r) => r.agentId));
}

export function registerOAuthConsentRoutes(app: App): void {
  // A single bounded read-only UX projection ordered by Application -> Space -> Agent.
  // Deliberately shows only current owner/admin Space memberships. It never
  // claims exact executable model operations or authorizes future execution.
  app.get("/api/v1/me/oauth/choices", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || principal.type !== "user"
      || principal.clientId !== c.env.OAUTH_ACCOUNT_APPLICATION_ID
      || principal.actor !== undefined || principal.purpose !== undefined) {
      throw new ApiError("FORBIDDEN", "Account user session is required", 403);
    }
    const rows = await c.env.DB.prepare(
      "SELECT DISTINCT s.id spaceId,s.name spaceName,g.grantee_id agentId " +
      "FROM space_memberships m JOIN spaces s ON s.id=m.space_id AND s.deleted_at IS NULL " +
      "JOIN data_grants g ON g.source_space_id=s.id " +
      "WHERE m.user_id=? AND m.deleted_at IS NULL AND m.role IN ('owner','admin') " +
      "AND g.grantee_type='agent' AND g.resource_type IN ('space','model') " +
      "AND g.permission IN ('read','write','manage') AND g.revoked_at IS NULL " +
      "AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now')) " +
      "ORDER BY s.name,g.grantee_id LIMIT 100",
    ).bind(principal.id).all<{ spaceId: string; spaceName: string; agentId: string }>();
    const ids = [...new Set(rows.results.map((r) => r.agentId))].slice(0, 30);
    const contexts = await resolveAgentContexts(c.env, ids);
    const result = rows.results.filter((r) => ids.includes(r.agentId)).flatMap((space) =>
      contexts.filter((agent) => agent.agentId === space.agentId)
        .map((agent) => ({ ...agent, spaceId: space.spaceId, spaceName: space.spaceName }))
    );
    c.header("Cache-Control", "no-store");
    return c.json(success({ candidates: result.slice(0, 100) }));
  });


  app.get("/api/v1/me/oauth/spaces/:spaceId/options", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || principal.type !== "user"
      || principal.clientId !== c.env.OAUTH_ACCOUNT_APPLICATION_ID
      || principal.actor !== undefined || principal.purpose !== undefined) {
      throw new ApiError("FORBIDDEN", "Account user session is required", 403);
    }
    const spaceId = c.req.param("spaceId");
    if (!SPACE_ID.test(spaceId)) throw new ApiError("INVALID_REQUEST", "Invalid Space ID", 400);
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    c.header("Cache-Control", "no-store");
    return c.json(success({ candidates: await candidates(c.env, spaceId) }));
  });

  // Only a pre-policy upper bound: do not claim model/record Policy, OAuth
  // resource scope or final execution-time authority have been checked.
  app.get("/api/v1/me/oauth/capabilities", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || principal.type !== "user"
      || principal.clientId !== c.env.OAUTH_ACCOUNT_APPLICATION_ID
      || principal.actor !== undefined || principal.purpose !== undefined) {
      throw new ApiError("FORBIDDEN", "Account user session is required", 403);
    }
    const query = new URL(c.req.url).searchParams;
    const appId = query.get("applicationId");
    const spaceId = query.get("spaceId");
    const agentId = query.get("agentId");
    if (query.size !== 3 || !safeApplication(appId) || !spaceId || !SPACE_ID.test(spaceId)
      || !agentId || !AGENT_ID.test(agentId)) {
      throw new ApiError("INVALID_REQUEST", "Application, Space and Agent must be selected exactly once", 400);
    }
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const eligible = await candidates(c.env, spaceId);
    if (!eligible.some((r) => r.applicationId === appId && r.agentId === agentId)) {
      throw new ApiError("OAUTH_SELECTION_DENIED", "Agent/Application has no active Space Grant", 403);
    }

    const [catalog, grants] = await c.env.DB.batch([
      c.env.DB.prepare(
        "SELECT model_key,max_access FROM application_model_access WHERE application_id=?",
      ).bind(appId),
      c.env.DB.prepare(
        "SELECT resource_type,resource_id,permission FROM data_grants " +
        "WHERE source_space_id=? AND grantee_type='agent' AND grantee_id=? " +
        "AND resource_type IN ('space','model') " +
        "AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))",
      ).bind(spaceId, agentId),
    ]);
    const modelAccess = new Map(
      (catalog.results as { model_key: string; max_access: ModelAccess }[])
        .map((r) => [r.model_key, r.max_access]),
    );
    const agentGrants = grants.results as Array<{
      resource_type: "space" | "model"; resource_id: string | null;
      permission: "free_busy" | "read" | "write" | "manage";
    }>;
    const direct = {
      type: "agent" as const, id: agentId, clientId: appId,
      tokenId: "oauth-consent-preview", scopes: ["resources:read", "resources:write", "resources:manage"],
    };
    const published = await listPublishedModels(c.env);
    const visible = visibleModelAccess(direct, published, modelAccess, null, agentGrants);
    c.header("Cache-Control", "no-store");
    return c.json(success({
      kind: "pre_policy_upper_bound",
      nativeModelsOnly: true,
      credentialScopesApplied: false,
      modelPolicyApplied: false,
      models: visible.slice(0, 50).map(({ model, access }) => ({
        key: model.key,
        name: model.definition.display?.name ?? model.key,
        access,
      })),
      truncated: visible.length > 50,
    }));
  });

  // Account BFF only. Browser-provided user IDs, Agent OAuth credentials, and
  // unrelated application's user tokens can never activate an OAuth grant.
  app.post("/api/v1/me/oauth/requests/:requestId/confirm", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || principal.type !== "user"
      || principal.clientId !== c.env.OAUTH_ACCOUNT_APPLICATION_ID
      || principal.actor !== undefined || principal.purpose !== undefined) {
      throw new ApiError("FORBIDDEN", "OAuth consent requires a verified Account user session", 403);
    }
    const requestId = c.req.param("requestId");
    if (!OAUTH_REQUEST_ID.test(requestId)) {
      throw new ApiError("INVALID_REQUEST", "Invalid OAuth request ID", 400);
    }
    const selected = parseConsent(await c.req.json<unknown>().catch(() => null));
    // First release intentionally limits direct Agent use consent to users
    // who can manage the selected Space. A viewer must not acquire a more
    // powerful Agent's existing independent Direct Grants by picking its ID.
    await requireSpacePermission(c.env, principal, selected.spaceId, "manage");
    const valid = await candidates(c.env, selected.spaceId);
    if (!valid.some((agent) => agent.agentId === selected.agentId && agent.applicationId === selected.applicationId)) {
      throw new ApiError("OAUTH_SELECTION_DENIED", "Agent has no active usable Grant in the selected Space", 403);
    }


    if (!c.env.IDENTITY || !c.env.OAUTH_CORE_APPROVER_SECRET) {
      throw new ApiError("OAUTH_NOT_CONFIGURED", "Trusted Identity OAuth approval is unavailable", 503);
    }
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
    if (!bearer) throw new ApiError("UNAUTHORIZED", "Account user token is required", 401);
    let response: Response;
    try {
      response = await c.env.IDENTITY.fetch(
        `https://identity.internal/oauth/requests/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lifespace-oauth-approver-secret": c.env.OAUTH_CORE_APPROVER_SECRET,
          },
          body: JSON.stringify({ userToken: bearer, ...selected }),
        },
      );
    } catch {
      throw new ApiError("OAUTH_IDENTITY_UNAVAILABLE", "Identity confirmation service is unavailable", 503);
    }
    if (!response.ok) {
      // Do not forward upstream secrets, untrusted client redirects or
      // arbitrary messages to the browser / application.
      if (response.status === 400 || response.status === 409) {
        throw new ApiError("OAUTH_REQUEST_INVALID", "OAuth request is expired or no longer pending", 409);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError("OAUTH_SELECTION_DENIED", "OAuth selection or user proof was rejected", 403);
      }
      throw new ApiError("OAUTH_CONFIRMATION_UNAVAILABLE", "OAuth confirmation could not be completed", 502);
    }
    const result = await response.json<unknown>().catch(() => null);
    if (!result || typeof result !== "object") {
      throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity OAuth confirmation", 502);
    }
    const value = result as Record<string, unknown>;
    if (typeof value.authorization_id !== "string" || !/^oaz_[A-Za-z0-9_-]+$/u.test(value.authorization_id)
      || typeof value.redirect_url !== "string") {
      throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity OAuth confirmation", 502);
    }
    let redirect: URL;
    try { redirect = new URL(value.redirect_url); }
    catch { throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity OAuth redirect", 502); }
    if (!((redirect.protocol === "https:") ||
      (redirect.protocol === "http:" && (redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]")))
      || !redirect.searchParams.get("code") || redirect.username || redirect.password) {
      throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity OAuth redirect", 502);
    }
    c.header("Cache-Control", "no-store");
    return c.json(success({
      authorizationId: value.authorization_id,
      redirectUrl: redirect.href,
    }));
  });
}
