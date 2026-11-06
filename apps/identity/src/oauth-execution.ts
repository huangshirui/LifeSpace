import type { Context, Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";
import { authorization, eligible } from "./oauth-authorization";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const READ_SCOPE = "resources:read";
const MAX_EXECUTION_TTL_SECONDS = 60;
type TokenRow = {
  authorization_id: string; client_id: string; resource: string; scopes: string;
  expires_at: string; revoked_at: string | null;
};
type ExecutionContext = {
  authorizationId: string; tokenHash: string; clientId: string;
  resource: string; applicationId: string; agentId: string; spaceId: string;
};
const oauthFailure = (status: 400 | 401 | 503, code: string) =>
  new Response(JSON.stringify({ error: code }), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function secretMatches(presented: string, expected: string | undefined): Promise<boolean> {
  if (!expected || !presented) return false;
  const a = await sha256(presented), b = await sha256(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function resourceAllowed(env: Bindings, resource: unknown): resource is string {
  return typeof resource === "string"
    && resource.length <= 1024
    && (env.OAUTH_ALLOWED_RESOURCES || "").split(/\s+/u).filter(Boolean).includes(resource);
}

function scopeList(raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  return Array.isArray(value) && value.every((x) => typeof x === "string") ? value : [];
}

async function validAccess(env: Bindings, tokenHash: string, resource: string) {
  const row = await env.DB.prepare(
    "SELECT authorization_id,client_id,resource,scopes,expires_at,revoked_at " +
    "FROM oauth_access_tokens WHERE token_hash=?",
  ).bind(tokenHash).first<TokenRow>();
  if (!row || row.resource !== resource || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;
  const selected = await authorization(env.DB, row.authorization_id);
  if (!eligible(selected) || selected.resource !== row.resource || selected.client_id !== row.client_id) return null;
  const scopes = scopeList(row.scopes);
  if (!scopes.includes(READ_SCOPE) || !scopeList(selected.scopes).includes(READ_SCOPE)) return null;
  return { selected, row };
}

function validContext(value: unknown): value is ExecutionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 7) return false;
  return typeof v.authorizationId === "string" && /^oaz_[A-Za-z0-9_-]{10,128}$/u.test(v.authorizationId)
    && typeof v.tokenHash === "string" && /^[a-f0-9]{64}$/u.test(v.tokenHash)
    && typeof v.clientId === "string" && /^ocli_[A-Za-z0-9_-]+$/u.test(v.clientId)
    && typeof v.resource === "string" && v.resource.length <= 1024
    && typeof v.applicationId === "string" && /^app_[A-Za-z0-9_-]+$/u.test(v.applicationId)
    && typeof v.agentId === "string" && /^agt_[A-Za-z0-9_-]+$/u.test(v.agentId)
    && typeof v.spaceId === "string" && /^spc_[A-Za-z0-9_-]+$/u.test(v.spaceId);
}

export function registerOAuthExecutionRoutes(app: App) {
  // The Resource Server holds a dedicated private secret, and may request a
  // short-lived Agent-direct Core token only for an actual current OAuth bearer.
  // The user represented by Consent is NOT implicitly the operation Principal.
  app.post("/oauth/execution-tokens", async (c: Context<AppEnv>) => {
    if (!await secretMatches(c.req.header("x-lifespace-resource-secret") || "", c.env.OAUTH_RESOURCE_SERVER_SECRET)) {
      return oauthFailure(401, "invalid_client");
    }
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((x) => x !== "token" && x !== "resource")) {
      return oauthFailure(400, "invalid_request");
    }
    const input = body as Record<string, unknown>;
    if (typeof input.token !== "string" || !/^lsp_oat_[A-Za-z0-9_-]{32,256}$/u.test(input.token)
      || !resourceAllowed(c.env, input.resource)) return oauthFailure(401, "invalid_token");
    const tokenHash = await sha256(input.token);
    const match = await validAccess(c.env, tokenHash, input.resource);
    if (!match) return oauthFailure(401, "invalid_token");
    if (!c.env.TOKEN_PRIVATE_KEY) return oauthFailure(503, "temporarily_unavailable");
    const { selected, row } = match;
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + MAX_EXECUTION_TTL_SECONDS, Math.floor(Date.parse(row.expires_at) / 1000));
    if (exp <= now) return oauthFailure(401, "invalid_token");
    const token = await sign({
      iss: "lifespace-identity", aud: "lifespace-core",
      sub: selected.agent_id, azp: selected.application_id,
      principal_type: "agent", principal_id: selected.agent_id,
      actor_type: "agent", actor_id: selected.agent_id,
      purpose: "oauth_agent_execution", scope: READ_SCOPE,
      oauth_authorization_id: selected.id, oauth_access_hash: tokenHash,
      oauth_resource: selected.resource, oauth_client_id: selected.client_id,
      oauth_space_id: selected.space_id,
      iat: now, exp, jti: "tok_" + crypto.randomUUID().replaceAll("-", ""),
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");
    return c.json({ data: {
      accessToken: token, tokenType: "Bearer", expiresIn: exp - now, scope: READ_SCOPE,
      applicationId: selected.application_id, agentId: selected.agent_id,
      spaceId: selected.space_id,
    } }, 200, { "cache-control": "no-store", pragma: "no-cache" });
  });

  // Private Core → Identity current-state check on *every Core request*. A
  // revoked OAuth access token invalidates even an unexpired execution JWT.
  app.post("/introspection/v1/oauth-executions", async (c: Context<AppEnv>) => {
    if (!await secretMatches(c.req.header("x-lifespace-internal-secret") || "", c.env.CORE_IDENTITY_SHARED_SECRET)) {
      return oauthFailure(401, "invalid_client");
    }
    const body = await c.req.json<unknown>().catch(() => null);
    if (!validContext(body) || !resourceAllowed(c.env, body.resource)) {
      return oauthFailure(400, "invalid_request");
    }
    const match = await validAccess(c.env, body.tokenHash, body.resource);
    const selected = match?.selected;
    const active = Boolean(selected && selected.id === body.authorizationId
      && selected.client_id === body.clientId
      && selected.application_id === body.applicationId
      && selected.agent_id === body.agentId
      && selected.space_id === body.spaceId);
    return c.json({ data: { active } }, 200, { "cache-control": "no-store" });
  });
}
