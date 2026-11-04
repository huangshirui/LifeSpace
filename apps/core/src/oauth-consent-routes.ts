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

export function registerOAuthConsentRoutes(app: App): void {
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
