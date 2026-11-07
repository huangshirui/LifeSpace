import type { Context, Hono } from "hono";
import { verify } from "hono/jwt";
import type { Bindings, Variables } from "./env";
import { configuredOAuthResource, liveOAuthResource } from "./oauth-mcp-resource";
import { cimdClientId, approvedCimdClientId, fetchClientMetadata } from "./oauth-client-metadata";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Form = Record<string, string>;
type OAuthClient = { id: string; redirect_uris: string; status: string };
type OAuthRequest = {
  id: string; client_id: string; redirect_uri: string; state: string | null;
  resource: string; scopes: string; code_challenge: string; status: string; expires_at: string;
};
type Authorization = {
  id: string; client_id: string; user_id: string; application_id: string; space_id: string; agent_id: string;
  resource: string; scopes: string; status: string; allow_user_authorization: number;
  userStatus: string; appStatus: string; agentStatus: string; bindingStatus: string; bindingRevoked: string | null;
  clientStatus: string; allowedScopes: string;
};
type CodeRow = { code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; authorization_id: string; expires_at: string; consumed_at: string | null };
type RefreshRow = { authorization_id: string; client_id: string; family_id: string; expires_at: string; consumed_at: string | null; revoked_at: string | null };
const id = (prefix: string) => prefix + "_" + crypto.randomUUID().replaceAll("-", "");
const instant = () => new Date().toISOString();
const secondsFromNow = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const json = (value: string) => {
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
};
const oauthError = (c: Context<AppEnv>, status: 400 | 401 | 403 | 503, error: string, description: string) =>
  c.json({ error, error_description: description }, status);
const randomSecret = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Url(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
async function equal(left: string, right: string): Promise<boolean> {
  const a = await hash(left), b = await hash(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function httpsUrl(value: unknown, allowLoopback = false): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    const url = new URL(value);
    const loopback = allowLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.hash || url.hostname.includes("*")) return null;
    return url.href;
  } catch { return null; }
}
function issuer(c: Context<AppEnv>): string | null {
  const url = httpsUrl(c.env.OAUTH_ISSUER);
  return url && new URL(url).pathname === "/" && !new URL(url).search ? new URL(url).origin : null;
}
function allowedResource(c: Context<AppEnv>, value: unknown): string | null {
  return configuredOAuthResource(c.env, value);
}
function scopes(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  const entries = value.trim() ? value.trim().split(/\s+/) : [];
  if (entries.some((s) => s.length > 100 || !/^[\x21-\x7e]+$/u.test(s)) || new Set(entries).size !== entries.length) return null;
  return entries;
}
function formField(body: Record<string, unknown> | null, key: string): string {
  const item = body?.[key];
  return typeof item === "string" ? item : "";
}
async function form(c: Context<AppEnv>): Promise<Form | null> {
  if (!(c.req.header("content-type") || "").includes("application/x-www-form-urlencoded")) return null;
  const body = await c.req.parseBody<Record<string, string | File>>().catch(() => null);
  if (!body || Object.values(body).some((v) => typeof v !== "string")) return null;
  return body as Form;
}
async function client(db: D1Database, clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 256) return null;
  return db.prepare("SELECT id,redirect_uris,status FROM oauth_clients WHERE id=?").bind(clientId).first<OAuthClient>();
}
// A URL-form client_id is treated as unverified metadata; only an explicit
// operator opt-in enables outbound discovery. The current document is fetched
// anew for each consent attempt; absent/invalid metadata never falls back to a
// previously cached redirect list or creates a permissive Client registration.
async function clientForAuthorization(c: Context<AppEnv>, clientId: string): Promise<OAuthClient | null> {
  if (!cimdClientId(clientId)) return client(c.env.DB, clientId);
  if (c.env.OAUTH_CIMD_ENABLED !== "1"
    || !approvedCimdClientId(clientId, c.env.OAUTH_CIMD_ALLOWED_CLIENT_IDS)) return null;
  const existing = await client(c.env.DB, clientId);
  if (existing?.status === "disabled") return null;
  const metadata = await fetchClientMetadata(clientId);
  if (!metadata) return null;
  const redirects = JSON.stringify(metadata.redirectUris);
  if (!existing) {
    // Bound anonymous metadata registration growth; this is still subject
    // to standard application-layer rate limiting before public enablement.
    const count = await c.env.DB.prepare(
      "SELECT count(*) AS total FROM oauth_clients WHERE id LIKE 'https://%'"
    ).first<{ total: number }>();
    if ((count?.total ?? 0) >= 1000) return null;
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO oauth_clients(id,display_name,redirect_uris,status,created_at) VALUES(?,?,?,'active',?)"
    ).bind(clientId, metadata.displayName, redirects, instant()).run();
  } else if (existing.redirect_uris !== redirects) {
    // A remote client must never silently expand or replace approved
    // callbacks after an earlier Consent was granted. An operator can
    // disable/review/re-register a changed Client, but not auto-migrate it.
    return null;
  }
  return client(c.env.DB, clientId);
}

export async function authorization(db: D1Database, authorizationId: string): Promise<Authorization | null> {
  return db.prepare("SELECT oa.*,u.status userStatus,a.status appStatus,a.allowed_scopes allowedScopes,ag.status agentStatus,aa.status bindingStatus,aa.revoked_at bindingRevoked,oc.status clientStatus FROM oauth_authorizations oa JOIN users u ON u.id=oa.user_id JOIN applications a ON a.id=oa.application_id JOIN agents ag ON ag.id=oa.agent_id JOIN agent_applications aa ON aa.agent_id=oa.agent_id AND aa.application_id=oa.application_id JOIN oauth_clients oc ON oc.id=oa.client_id WHERE oa.id=?")
    .bind(authorizationId).first<Authorization>();
}
export function eligible(a: Authorization | null): a is Authorization {
  return Boolean(a) && a!.status === "active" && a!.userStatus === "active" && a!.appStatus === "active"
    && a!.agentStatus === "active" && a!.bindingStatus === "active" && !a!.bindingRevoked
    && a!.clientStatus === "active" && json(a!.scopes).every((s) => json(a!.allowedScopes).includes(s));
}
async function issueTokens(c: Context<AppEnv>, a: Authorization, familyId: string) {
  const access = randomSecret("lsp_oat_");
  const refresh = randomSecret("lsp_ort_");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO oauth_access_tokens(token_hash,authorization_id,client_id,resource,scopes,expires_at) VALUES(?,?,?,?,?,?)")
      .bind(await hash(access), a.id, a.client_id, a.resource, a.scopes, secondsFromNow(300)),
    c.env.DB.prepare("INSERT INTO oauth_refresh_tokens(token_hash,authorization_id,client_id,family_id,expires_at) VALUES(?,?,?,?,?)")
      .bind(await hash(refresh), a.id, a.client_id, familyId, secondsFromNow(14 * 86400)),
  ]);
  return c.json({
    access_token: access, token_type: "Bearer", expires_in: 300, refresh_token: refresh,
    scope: json(a.scopes).join(" "), resource: a.resource,
  }, 200, { "cache-control": "no-store", pragma: "no-cache" });
}

export async function exchangeInteractiveOAuthToken(c: Context<AppEnv>, body: Form) {
  const grantType = body.grant_type;
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(c, 400, "unsupported_grant_type", "Unsupported OAuth grant type");
  }
  const clientId = formField(body, "client_id");
  const currentClient = await client(c.env.DB, clientId);
  if (!currentClient || currentClient.status !== "active") return oauthError(c, 401, "invalid_client", "Unknown or disabled OAuth client");
  if (body.client_secret || c.req.header("authorization")) return oauthError(c, 401, "invalid_client", "This registration is a public PKCE client");

  if (grantType === "authorization_code") {
    const code = formField(body, "code");
    const verifier = formField(body, "code_verifier");
    const redirect = formField(body, "redirect_uri");
    if (!code.startsWith("lsp_oac_") || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
      return oauthError(c, 400, "invalid_grant", "Code or PKCE verifier is invalid");
    }
    const row = await c.env.DB.prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash=?")
      .bind(await hash(code)).first<CodeRow>();
    if (!row || row.client_id !== clientId || row.redirect_uri !== redirect || row.consumed_at
      || Date.parse(row.expires_at) <= Date.now() || await sha256Url(verifier) !== row.code_challenge) {
      return oauthError(c, 400, "invalid_grant", "Invalid, expired or consumed authorization code");
    }
    const a = await authorization(c.env.DB, row.authorization_id);
    if (!eligible(a) || (body.resource && body.resource !== a.resource)) {
      return oauthError(c, 400, "invalid_grant", "Authorization is no longer eligible");
    }
    const consumed = await c.env.DB.prepare("UPDATE oauth_authorization_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?")
      .bind(instant(), row.code_hash, instant()).run();
    if (consumed.meta.changes !== 1) return oauthError(c, 400, "invalid_grant", "Authorization code was already consumed");
    return issueTokens(c, a, id("orf"));
  }

  const refresh = formField(body, "refresh_token");
  if (!refresh.startsWith("lsp_ort_")) return oauthError(c, 400, "invalid_grant", "Refresh token is invalid");
  const refreshHash = await hash(refresh);
  const row = await c.env.DB.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash=?").bind(refreshHash).first<RefreshRow>();
  if (!row || row.client_id !== clientId || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    return oauthError(c, 400, "invalid_grant", "Refresh token is invalid or expired");
  }
  if (row.consumed_at) {
    await c.env.DB.prepare("UPDATE oauth_authorizations SET status='revoked',revoked_at=? WHERE id=? AND status='active'")
      .bind(instant(), row.authorization_id).run();
    return oauthError(c, 400, "invalid_grant", "Refresh reuse detected; authorization revoked");
  }
  const a = await authorization(c.env.DB, row.authorization_id);
  if (!eligible(a) || (body.resource && body.resource !== a.resource)) {
    return oauthError(c, 400, "invalid_grant", "Authorization is no longer eligible");
  }
  const consumed = await c.env.DB.prepare("UPDATE oauth_refresh_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?")
    .bind(instant(), refreshHash, instant()).run();
  if (consumed.meta.changes !== 1) {
    await c.env.DB.prepare("UPDATE oauth_authorizations SET status='revoked',revoked_at=? WHERE id=? AND status='active'")
      .bind(instant(), row.authorization_id).run();
    return oauthError(c, 400, "invalid_grant", "Concurrent refresh reuse detected");
  }
  return issueTokens(c, a, row.family_id);
}

export function registerOAuthAuthorizationServer(app: App) {
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = issuer(c);
    if (!base) return oauthError(c, 503, "temporarily_unavailable", "OAuth issuer is not configured");
    return c.json({
      issuer: base, authorization_endpoint: base + "/oauth/authorize", token_endpoint: base + "/oauth/token",
      revocation_endpoint: base + "/oauth/revoke",
      introspection_endpoint: base + "/oauth/introspect",
      ...(c.env.OAUTH_CIMD_ENABLED === "1" ? { client_id_metadata_document_supported: true } : {}),
      ...(c.env.OAUTH_DCR_ENABLED === "1" && c.env.ENVIRONMENT !== "production" ? { registration_endpoint: base + "/oauth/register" } : {}),
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"], scopes_supported: ["resources:read", "resources:write", "resources:manage"],
    }, 200, { "cache-control": "public, max-age=300" });
  });

  app.post("/oauth/register", async (c) => {
    if (c.env.OAUTH_DCR_ENABLED !== "1" || c.env.ENVIRONMENT === "production" || !issuer(c)) {
      return oauthError(c, 403, "access_denied", "Dynamic client registration is disabled");
    }
    const raw = await c.req.text();
    if (raw.length > 8192) return oauthError(c, 400, "invalid_client_metadata", "Client metadata is too large");
    let input: Record<string, unknown> | null = null;
    try { input = JSON.parse(raw) as Record<string, unknown>; } catch { /* invalid */ }
    if (!input || Array.isArray(input) || !Array.isArray(input.redirect_uris)
      || input.redirect_uris.length < 1 || input.redirect_uris.length > 8
      || input.redirect_uris.some((v) => !httpsUrl(v, true))) {
      return oauthError(c, 400, "invalid_redirect_uri", "Exact HTTPS or native loopback redirect URIs are required");
    }
    if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
      return oauthError(c, 400, "invalid_client_metadata", "Only public PKCE clients are supported");
    }
    if (input.grant_types !== undefined && JSON.stringify(input.grant_types) !== JSON.stringify(["authorization_code", "refresh_token"])) {
      return oauthError(c, 400, "invalid_client_metadata", "Only Authorization Code and Refresh Token are supported");
    }
    const redirectUris = (input.redirect_uris as string[]).map((u) => httpsUrl(u, true)!);
    if (new Set(redirectUris).size !== redirectUris.length) return oauthError(c, 400, "invalid_redirect_uri", "Duplicate redirects");
    const name = typeof input.client_name === "string" && input.client_name.trim() && input.client_name.length <= 100
      ? input.client_name.trim() : "Unnamed OAuth Client";
    const clientId = id("ocli");
    await c.env.DB.prepare("INSERT INTO oauth_clients(id,display_name,redirect_uris,status,created_at) VALUES(?,?,?,'active',?)")
      .bind(clientId, name, JSON.stringify(redirectUris), instant()).run();
    return c.json({
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name,
      redirect_uris: redirectUris, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }, 201, { "cache-control": "no-store" });
  });

  app.get("/oauth/authorize", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const clientId = params.get("client_id") || "";
    const redirect = params.get("redirect_uri");
    const state = params.get("state");
    const challenge = params.get("code_challenge");
    const resource = allowedResource(c, params.get("resource"));
    const requested = scopes(params.get("scope") || "");
    if (params.get("response_type") !== "code" || !state || state.length < 16 || state.length > 1024
      || params.get("code_challenge_method") !== "S256" || !challenge
      || !/^[A-Za-z0-9_-]{43}$/u.test(challenge) || !resource || requested === null) {
      return oauthError(c, 400, "invalid_request", "Code, state, S256 PKCE and approved resource are required");
    }
    // A syntactically valid resource is not proof of an enabled Core MCP Server.
    if (!await liveOAuthResource(c.env, resource)) {
      return oauthError(c, 400, "invalid_request", "MCP resource is not currently enabled");
    }
    // Only valid OAuth requests may trigger a bounded remote CIMD fetch.
    const registered = await clientForAuthorization(c, clientId);
    if (!registered || registered.status !== "active") {
      return oauthError(c, 400, "invalid_client", "Client is not registered or metadata is unavailable");
    }
    if (!redirect || !json(registered.redirect_uris).includes(redirect)) {
      return oauthError(c, 400, "invalid_request", "Redirect URI is not registered");
    }

    const consent = httpsUrl(c.env.OAUTH_CONSENT_URL);
    if (!issuer(c) || !consent) return oauthError(c, 503, "temporarily_unavailable", "OAuth consent service is not configured");
    const requestId = id("oar");
    await c.env.DB.prepare("INSERT INTO oauth_authorization_requests(id,client_id,redirect_uri,state,resource,scopes,code_challenge,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)")
      .bind(requestId, clientId, redirect, state, resource, JSON.stringify(requested), challenge, secondsFromNow(600), instant()).run();
    const target = new URL(consent);
    target.searchParams.set("request_id", requestId);
    return c.redirect(target.href, 302);
  });

  // Account-only read of unbound/pending consent metadata. This never conveys
  // current Data Grants, user entitlement or successful authorization.
  app.get("/api/v1/me/oauth/requests/:requestId", async (c) => {
    const principal = c.get("principal");
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || principal.clientId !== c.env.OAUTH_ACCOUNT_APPLICATION_ID) {
      return oauthError(c, 403, "access_denied", "Account user session is required");
    }
    const requestId = c.req.param("requestId");
    if (!/^oar_[A-Za-z0-9_-]{16,128}$/u.test(requestId)) {
      return oauthError(c, 400, "invalid_request", "Invalid OAuth authorization request");
    }
    const row = await c.env.DB.prepare(
      "SELECT r.*, cl.display_name clientName, cl.status clientStatus FROM oauth_authorization_requests r JOIN oauth_clients cl ON cl.id=r.client_id WHERE r.id=?",
    ).bind(requestId).first<OAuthRequest & { clientName: string; clientStatus: string }>();
    if (!row || row.clientStatus !== "active" || row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      return oauthError(c, 400, "invalid_request", "OAuth request is not pending");
    }
    return c.json({ data: {
      id: row.id,
      client: {
        id: row.client_id, name: row.clientName,
        redirectOrigin: new URL(row.redirect_uri).origin,
        verifiedVendor: false,
      },
      resource: row.resource, requestedScopes: json(row.scopes),
      expiresAt: row.expires_at, status: row.status,
    } }, 200, { "cache-control": "no-store" });
  });

  // Core-only bounded resolution of Agent/Application identities that Core has
  // already selected from a manager's current Space Data Grants.
  app.post("/oauth/core/agent-candidates", async (c) => {
    const provided = c.req.header("x-lifespace-internal-secret") || "";
    if (!c.env.CORE_IDENTITY_SHARED_SECRET || !provided || !await equal(provided, c.env.CORE_IDENTITY_SHARED_SECRET)) {
      return oauthError(c, 401, "invalid_client", "Trusted Core service is required");
    }
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "agentIds")) {
      return oauthError(c, 400, "invalid_request", "Bounded Agent IDs are required");
    }
    const agentIds = (body as { agentIds?: unknown }).agentIds;
    if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > 30
      || agentIds.some((v) => typeof v !== "string" || !/^agt_[A-Za-z0-9_-]{3,128}$/u.test(v))
      || new Set(agentIds).size !== agentIds.length) {
      return oauthError(c, 400, "invalid_request", "Invalid Agent candidate set");
    }
    const placeholders = agentIds.map(() => "?").join(",");
    const result = await c.env.DB.prepare(
      "SELECT ag.id agentId,ag.display_name agentName,ap.id applicationId,ap.name applicationName " +
      "FROM agents ag JOIN agent_applications aa ON aa.agent_id=ag.id " +
      "JOIN applications ap ON ap.id=aa.application_id " +
      "WHERE ag.id IN (" + placeholders + ") AND ag.status='active' " +
      "AND aa.status='active' AND aa.revoked_at IS NULL AND ap.status='active' " +
      "ORDER BY ap.name,ag.display_name LIMIT 60",
    ).bind(...agentIds).all<{ agentId: string; agentName: string; applicationId: string; applicationName: string }>();
    return c.json({ data: result.results }, 200, { "cache-control": "no-store" });
  });

  // Private Core -> Identity boundary. The Account BFF cannot directly approve OAuth.
  // Core must first verify the user's Account session and selected Space/Agent eligibility.
  app.post("/oauth/requests/:requestId/approve", async (c) => {
    const key = c.req.header("x-lifespace-oauth-approver-secret") || "";
    if (!c.env.OAUTH_CORE_APPROVER_SECRET || !key || !await equal(key, c.env.OAUTH_CORE_APPROVER_SECRET)) {
      return oauthError(c, 401, "invalid_client", "Trusted Core authorization is required");
    }
    if (!c.env.OAUTH_ACCOUNT_APPLICATION_ID || !c.env.TOKEN_PUBLIC_KEY) {
      return oauthError(c, 503, "temporarily_unavailable", "OAuth consent proof is not configured");
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body.userToken !== "string" || typeof body.applicationId !== "string"
      || typeof body.spaceId !== "string" || !/^spc_[A-Za-z0-9_-]+$/u.test(body.spaceId)
      || typeof body.agentId !== "string" || !/^agt_[A-Za-z0-9_-]+$/u.test(body.agentId)
      || typeof body.allowUserAuthorization !== "boolean") {
      return oauthError(c, 400, "invalid_request", "Trusted consent context is incomplete");
    }
    let claims: Record<string, unknown>;
    try { claims = await verify(body.userToken, c.env.TOKEN_PUBLIC_KEY, "RS256"); }
    catch { return oauthError(c, 401, "invalid_grant", "Account user proof is invalid"); }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== "lifespace-identity" || !audiences.includes("lifespace-identity")
      || claims.principal_type !== "user" || claims.azp !== c.env.OAUTH_ACCOUNT_APPLICATION_ID
      || typeof claims.sub !== "string") {
      return oauthError(c, 403, "access_denied", "Account user proof is not eligible");
    }
    const request = await c.env.DB.prepare("SELECT * FROM oauth_authorization_requests WHERE id=?")
      .bind(c.req.param("requestId")).first<OAuthRequest>();
    if (!request || request.status !== "pending" || Date.parse(request.expires_at) <= Date.now()) {
      return oauthError(c, 400, "invalid_request", "Authorization request is missing, expired or completed");
    }
    // Recheck after a pending request is opened; a Server may be disabled
    // before the user confirms Consent.
    if (!await liveOAuthResource(c.env, request.resource)) {
      return oauthError(c, 403, "access_denied", "MCP resource is no longer available");
    }
    // Remote metadata may disappear or change between authorization and
    // browser approval. Revalidate the pinned URL document before issuing
    // a code; never follow a newly advertised redirect.
    if (cimdClientId(request.client_id)) {
      const currentClient = await clientForAuthorization(c, request.client_id);
      if (!currentClient || !json(currentClient.redirect_uris).includes(request.redirect_uri)) {
        return oauthError(c, 403, "access_denied", "Client metadata is no longer eligible");
      }
    }
    const user = await c.env.DB.prepare("SELECT status FROM users WHERE id=?").bind(claims.sub).first<{ status: string }>();
    const agent = await c.env.DB.prepare("SELECT a.status agentStatus,aa.status bindingStatus,aa.revoked_at revokedAt,app.status appStatus,app.allowed_scopes allowedScopes FROM agents a JOIN agent_applications aa ON aa.agent_id=a.id JOIN applications app ON app.id=aa.application_id WHERE a.id=? AND app.id=?")
      .bind(body.agentId, body.applicationId).first<{ agentStatus: string; bindingStatus: string; revokedAt: string | null; appStatus: string; allowedScopes: string }>();
    if (user?.status !== "active" || !agent || agent.agentStatus !== "active" || agent.bindingStatus !== "active"
      || agent.revokedAt || agent.appStatus !== "active" || !json(request.scopes).every((s) => json(agent.allowedScopes).includes(s))) {
      return oauthError(c, 403, "access_denied", "Selected Agent, Application or scope is not eligible");
    }
    const currentIssuer = issuer(c);
    if (!currentIssuer) return oauthError(c, 503, "temporarily_unavailable", "OAuth issuer unavailable");
    const authzId = id("oaz");
    const code = randomSecret("lsp_oac_");
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO oauth_authorizations(id,request_id,client_id,user_id,application_id,space_id,agent_id,allow_user_authorization,resource,scopes,status,created_at) SELECT ?,?,client_id,?,?,?,?,?,resource,scopes,'active',? FROM oauth_authorization_requests WHERE id=? AND status='pending' AND expires_at>?")
          .bind(authzId, request.id, claims.sub, body.applicationId, body.spaceId, body.agentId, body.allowUserAuthorization ? 1 : 0, instant(), request.id, instant()),
        c.env.DB.prepare("INSERT INTO oauth_authorization_codes(code_hash,authorization_id,client_id,redirect_uri,code_challenge,expires_at) VALUES(?,?,?,?,?,?)")
          .bind(await hash(code), authzId, request.client_id, request.redirect_uri, request.code_challenge, secondsFromNow(300)),
        c.env.DB.prepare("UPDATE oauth_authorization_requests SET status='approved' WHERE id=? AND status='pending'")
          .bind(request.id),
      ]);
    } catch {
      return oauthError(c, 400, "invalid_request", "Authorization request was already completed");
    }
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);
    // RFC 9207 issuer identifier protects clients from AS mix-up during
    // the browser callback. Never infer this from the request Host header.
    redirect.searchParams.set("iss", currentIssuer);
    return c.json({ redirect_url: redirect.href, authorization_id: authzId }, 200, { "cache-control": "no-store" });
  });

  app.post("/oauth/introspect", async (c) => {
    const key = c.req.header("x-lifespace-resource-secret") || "";
    if (!c.env.OAUTH_RESOURCE_SERVER_SECRET || !key || !await equal(key, c.env.OAUTH_RESOURCE_SERVER_SECRET)) {
      return oauthError(c, 401, "invalid_client", "Trusted Resource Server authentication is required");
    }
    const body = await form(c);
    if (!body) return oauthError(c, 400, "invalid_request", "Form encoding is required");
    const token = formField(body, "token");
    const resource = allowedResource(c, formField(body, "resource"));
    if (!token || !resource) return c.json({ active: false });
    const row = await c.env.DB.prepare("SELECT authorization_id,client_id,resource,scopes,expires_at,revoked_at FROM oauth_access_tokens WHERE token_hash=?")
      .bind(await hash(token)).first<{ authorization_id: string; client_id: string; resource: string; scopes: string; expires_at: string; revoked_at: string | null }>();
    if (!row || row.resource !== resource || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return c.json({ active: false });
    const a = await authorization(c.env.DB, row.authorization_id);
    if (!eligible(a) || a.resource !== row.resource || a.client_id !== row.client_id) return c.json({ active: false });
    return c.json({
      active: true, client_id: a.client_id, authorization_id: a.id, sub: a.user_id,
      application_id: a.application_id, space_id: a.space_id, agent_id: a.agent_id,
      allow_user_authorization: a.allow_user_authorization === 1, resource: a.resource,
      scope: json(row.scopes).join(" "), exp: Math.floor(Date.parse(row.expires_at) / 1000),
    }, 200, { "cache-control": "no-store" });
  });

  app.post("/oauth/revoke", async (c) => {
    const body = await form(c);
    if (!body) return oauthError(c, 400, "invalid_request", "Form encoding is required");
    const clientId = formField(body, "client_id");
    const token = formField(body, "token");
    if (!await client(c.env.DB, clientId)) return oauthError(c, 401, "invalid_client", "Client is not registered");
    if (!token || token.length > 1024) return oauthError(c, 400, "invalid_request", "Token is required");
    const digest = await hash(token);
    await c.env.DB.prepare("UPDATE oauth_access_tokens SET revoked_at=? WHERE token_hash=? AND client_id=? AND revoked_at IS NULL")
      .bind(instant(), digest, clientId).run();
    const refresh = await c.env.DB.prepare("SELECT authorization_id FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=?")
      .bind(digest, clientId).first<{ authorization_id: string }>();
    if (refresh) await c.env.DB.prepare("UPDATE oauth_authorizations SET status='revoked',revoked_at=? WHERE id=? AND status='active'")
      .bind(instant(), refresh.authorization_id).run();
    return c.body(null, 200, { "cache-control": "no-store" });
  });
}
