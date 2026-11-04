import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import { ApiError, success } from "./http";

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

async function candidates(env: Bindings, spaceId: string): Promise<AgentCandidate[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT g.grantee_id agentId FROM data_grants g " +
    "JOIN spaces s ON s.id=g.source_space_id AND s.deleted_at IS NULL " +
    "WHERE g.source_space_id=? AND g.grantee_type='agent' " +
    "AND g.resource_type IN ('space','model') AND g.permission IN ('read','write','manage') " +
    "AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now')) " +
    "ORDER BY g.grantee_id LIMIT 30",
  ).bind(spaceId).all<{ agentId: string }>();
  if (!rows.results.length) return [];
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw new ApiError("OAUTH_NOT_CONFIGURED", "Identity Agent context is unavailable", 503);
  }
  let result: Response;
  try {
    result = await env.IDENTITY.fetch("https://identity.internal/internal/v1/oauth/agent-candidates", {
      method: "POST",
      headers: { "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ agentIds: rows.results.map((r) => r.agentId) }),
    });
  } catch {
    throw new ApiError("OAUTH_IDENTITY_UNAVAILABLE", "Identity Agent context is unavailable", 503);
  }
  if (!result.ok) throw new ApiError("OAUTH_IDENTITY_UNAVAILABLE", "Identity Agent context was rejected", 503);
  const payload = await result.json<unknown>().catch(() => null);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new ApiError("OAUTH_INVALID_RESPONSE", "Invalid Identity Agent context", 502);
  }
  const allowedIds = new Set(rows.results.map((r) => r.agentId));
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

export function registerOAuthConsentRoutes(app: App): void {
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
