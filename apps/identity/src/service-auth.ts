import type { Context } from "hono";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";
import { measurePerformancePhase } from "./performance-timing";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type TrustedApplication = {
  id: string;
  allowedScopes: string[];
  accessTokenTtlSeconds: number;
};
type ServicePrincipalRow = {
  id: string;
  application_id: string;
  display_name: string;
  description: string | null;
  max_scopes: string;
  status: "active" | "disabled";
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};
type ServiceTokenRow = {
  id: string;
  principal_id: string;
  display_prefix: string;
  last_four: string;
  label: string;
  scopes: string;
  audience: string;
  expires_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};
type OAuthCredentialRow = {
  id: string;
  principal_id: string;
  secret_suffix: string;
  label: string;
  status: "active" | "revoked";
  created_at: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

const TOKEN_ISSUER = "lifespace-identity";
const TOKEN_AUDIENCE = "lifespace-core";
const TOKEN_HASH_VERSION = 1;
const SERVICE_TOKEN_PREFIX = "lsp_svc_";
const LEGACY_SERVICE_TOKEN_PREFIX = "lsp_pat_";
const OAUTH_SECRET_PREFIX = "lsp_client_";

export function isOpaqueServiceApiToken(value: string): boolean {
  return value.startsWith(SERVICE_TOKEN_PREFIX) || value.startsWith(LEGACY_SERVICE_TOKEN_PREFIX);
}

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  return constantTimeEqualDigest(await sha256(left), await sha256(right));
}

async function matchesStoredHash(value: string, expectedHash: string): Promise<boolean> {
  return constantTimeEqualDigest(await sha256(value), expectedHash);
}

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${prefix}${raw}`;
}

function parseScopes(value: unknown, field = "scopes"): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  const result = value.map((scope) => scope.trim());
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`);
  return result;
}

function scopeSubset(requested: string[], ceiling: string[]): boolean {
  return requested.every((scope) => ceiling.includes(scope));
}

function parseInstantOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an RFC 3339 UTC instant or null`);
  }
  if (Date.parse(value) <= Date.now()) throw new Error(`${field} must be in the future`);
  return value;
}

function text(value: unknown, field: string, max: number, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} is invalid`);
  return value.trim();
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

async function trustedApplication(c: Context<AppEnv>): Promise<TrustedApplication | null> {
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const secret = authorization.slice(7).trim();
  if (!secret.startsWith("lsa_") || secret.length < 40) return null;
  const credential = await c.env.DB.prepare(`
    SELECT a.id,
           a.allowed_scopes allowedScopes,
           a.access_token_ttl_seconds accessTokenTtlSeconds
    FROM application_credentials c
    JOIN applications a ON a.id=c.application_id
    WHERE c.secret_hash=? AND c.status='active' AND c.revoked_at IS NULL
      AND a.status='active' AND a.trusted_backend=1
  `).bind(await sha256(secret)).first<{ id: string; allowedScopes: string; accessTokenTtlSeconds: number }>();
  if (!credential) return null;
  return { id: credential.id, allowedScopes: parseJsonArray(credential.allowedScopes), accessTokenTtlSeconds: credential.accessTokenTtlSeconds };
}

async function requireTrustedApplication(c: Context<AppEnv>): Promise<TrustedApplication | Response> {
  const application = await trustedApplication(c);
  if (!application) return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
  return application;
}

async function activeUser(env: Bindings, userId: unknown): Promise<string | null> {
  if (userId === undefined || userId === null || userId === "") return null;
  if (typeof userId !== "string" || !userId.startsWith("usr_")) throw new Error("createdByUserId is invalid");
  const user = await env.DB.prepare("SELECT status FROM users WHERE id=?").bind(userId).first<{ status: string }>();
  if (!user || user.status !== "active") throw new Error("createdByUserId must reference an active LifeSpace user");
  return userId;
}

async function principalForApplication(env: Bindings, principalId: string, applicationId: string): Promise<ServicePrincipalRow | null> {
  return env.DB.prepare(`SELECT id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
    FROM service_principals WHERE id=? AND application_id=?`).bind(principalId, applicationId).first<ServicePrincipalRow>();
}

function principalDto(row: ServicePrincipalRow) {
  return {
    id: row.id,
    clientId: row.application_id,
    displayName: row.display_name,
    description: row.description,
    maxScopes: parseJsonArray(row.max_scopes),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

function tokenDto(row: ServiceTokenRow) {
  return {
    id: row.id,
    principalId: row.principal_id,
    displayPrefix: row.display_prefix,
    lastFour: row.last_four,
    label: row.label,
    scopes: parseJsonArray(row.scopes),
    audience: row.audience,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function oauthCredentialDto(row: OAuthCredentialRow) {
  return {
    id: row.id,
    principalId: row.principal_id,
    secretSuffix: row.secret_suffix,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

async function parseJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

function oauthError(c: Context<AppEnv>, status: 400 | 401, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

function deferOperationalWrite(c: Context<AppEnv>, operation: Promise<unknown>): void {
  const guarded = operation.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // Direct Hono app.request() tests do not provide a Worker ExecutionContext.
    // The best-effort write still runs without delaying the response.
    void guarded;
  }
}

export function registerServiceAuthenticationRoutes(app: App): void {
  app.post("/api/v1/service-principals", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const body = await parseJsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    try {
      const displayName = text(body.displayName, "displayName", 100) as string;
      const description = text(body.description, "description", 500, true);
      const maxScopes = parseScopes(body.maxScopes ?? [], "maxScopes");
      if (!scopeSubset(maxScopes, application.allowedScopes)) {
        return c.json(fail("FORBIDDEN", "Service principal scopes exceed the application scope ceiling", c.get("requestId")), 403);
      }
      const createdByUserId = await activeUser(c.env, body.createdByUserId);
      const principalId = createId("svc");
      const timestamp = now();
      await c.env.DB.prepare(`INSERT INTO service_principals(id,application_id,display_name,description,max_scopes,created_by_user_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(principalId, application.id, displayName, description, JSON.stringify(maxScopes), createdByUserId, timestamp, timestamp).run();
      const row = await principalForApplication(c.env, principalId, application.id);
      if (!row) throw new Error("Service principal missing after creation");
      return c.json(ok(principalDto(row)), 201);
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service principal", c.get("requestId")), 422);
    }
  });

  app.get("/api/v1/service-principals", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const createdByUserId = c.req.query("createdByUserId")?.trim();
    const rows = createdByUserId
      ? await c.env.DB.prepare(`SELECT id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
          FROM service_principals WHERE application_id=? AND created_by_user_id=? ORDER BY created_at DESC`).bind(application.id, createdByUserId).all<ServicePrincipalRow>()
      : await c.env.DB.prepare(`SELECT id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
          FROM service_principals WHERE application_id=? ORDER BY created_at DESC`).bind(application.id).all<ServicePrincipalRow>();
    return c.json(ok(rows.results.map(principalDto)));
  });

  app.patch("/api/v1/service-principals/:principalId", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const row = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!row) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const body = await parseJsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    try {
      const keys = Object.keys(body);
      if (!keys.length || keys.some((key) => !["displayName", "description", "status", "maxScopes"].includes(key))) throw new Error("Unsupported service principal update");
      const displayName = body.displayName === undefined ? row.display_name : text(body.displayName, "displayName", 100) as string;
      const description = body.description === undefined ? row.description : text(body.description, "description", 500, true);
      const status = body.status === undefined ? row.status : body.status;
      if (status !== "active" && status !== "disabled") throw new Error("status must be active or disabled");
      const previousMax = parseJsonArray(row.max_scopes);
      const maxScopes = body.maxScopes === undefined ? previousMax : parseScopes(body.maxScopes, "maxScopes");
      if (!scopeSubset(maxScopes, application.allowedScopes)) return c.json(fail("FORBIDDEN", "Service principal scopes exceed the application scope ceiling", c.get("requestId")), 403);
      // The principal ceiling may change within the registered application's ceiling.
      // Existing opaque tokens keep their own scopes and therefore never auto-expand.
      const timestamp = now();
      const disabledAt = status === "disabled" ? (row.disabled_at ?? timestamp) : null;
      await c.env.DB.prepare(`UPDATE service_principals SET display_name=?,description=?,max_scopes=?,status=?,updated_at=?,disabled_at=? WHERE id=? AND application_id=?`)
        .bind(displayName, description, JSON.stringify(maxScopes), status, timestamp, disabledAt, row.id, application.id).run();
      const updated = await principalForApplication(c.env, row.id, application.id);
      if (!updated) throw new Error("Service principal missing after update");
      return c.json(ok(principalDto(updated)));
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service principal update", c.get("requestId")), 422);
    }
  });

  app.post("/api/v1/service-principals/:principalId/tokens", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    if (principal.status !== "active") return c.json(fail("SERVICE_PRINCIPAL_DISABLED", "Service principal is disabled", c.get("requestId")), 409);
    const body = await parseJsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    try {
      const label = text(body.label, "label", 100) as string;
      const scopes = parseScopes(body.scopes ?? [], "scopes");
      const principalScopes = parseJsonArray(principal.max_scopes);
      if (!scopeSubset(scopes, principalScopes) || !scopeSubset(scopes, application.allowedScopes)) {
        return c.json(fail("FORBIDDEN", "Token scopes exceed the current scope ceiling", c.get("requestId")), 403);
      }
      const expiresAt = parseInstantOrNull(body.expiresAt, "expiresAt");
      const createdByUserId = await activeUser(c.env, body.createdByUserId);
      const plaintext = randomSecret(SERVICE_TOKEN_PREFIX);
      const timestamp = now();
      const tokenId = createId("sat");
      await c.env.DB.prepare(`INSERT INTO service_api_tokens(id,principal_id,token_hash_version,token_hash,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          tokenId, principal.id, TOKEN_HASH_VERSION, await sha256(plaintext), plaintext.slice(0, 16), plaintext.slice(-4), label,
          JSON.stringify(scopes), TOKEN_AUDIENCE, expiresAt, timestamp, createdByUserId,
        ).run();
      const row = await c.env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
        FROM service_api_tokens WHERE id=?`).bind(tokenId).first<ServiceTokenRow>();
      if (!row) throw new Error("Service token metadata missing after creation");
      return c.json(ok({ ...tokenDto(row), token: plaintext }), 201);
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid token request", c.get("requestId")), 422);
    }
  });

  app.get("/api/v1/service-principals/:principalId/tokens", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
      FROM service_api_tokens WHERE principal_id=? ORDER BY created_at DESC`).bind(principal.id).all<ServiceTokenRow>();
    return c.json(ok(rows.results.map(tokenDto)));
  });

  app.patch("/api/v1/service-principals/:principalId/tokens/:tokenId", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const token = await c.env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
      FROM service_api_tokens WHERE id=? AND principal_id=?`).bind(c.req.param("tokenId"), principal.id).first<ServiceTokenRow>();
    if (!token || token.revoked_at) return c.json(fail("SERVICE_TOKEN_NOT_FOUND", "Active service token not found", c.get("requestId")), 404);
    const body = await parseJsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    try {
      const keys = Object.keys(body);
      if (!keys.length || keys.some((key) => !["label", "scopes", "expiresAt"].includes(key))) throw new Error("Unsupported token update");
      const label = body.label === undefined ? token.label : text(body.label, "label", 100) as string;
      const previousScopes = parseJsonArray(token.scopes);
      const scopes = body.scopes === undefined ? previousScopes : parseScopes(body.scopes, "scopes");
      if (!scopeSubset(scopes, previousScopes)) throw new Error("Token scopes may only be reduced");
      const expiresAt = body.expiresAt === undefined ? token.expires_at : parseInstantOrNull(body.expiresAt, "expiresAt");
      await c.env.DB.prepare("UPDATE service_api_tokens SET label=?,scopes=?,expires_at=? WHERE id=? AND principal_id=? AND revoked_at IS NULL")
        .bind(label, JSON.stringify(scopes), expiresAt, token.id, principal.id).run();
      const updated = await c.env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
        FROM service_api_tokens WHERE id=?`).bind(token.id).first<ServiceTokenRow>();
      if (!updated) throw new Error("Service token missing after update");
      return c.json(ok(tokenDto(updated)));
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid token update", c.get("requestId")), 422);
    }
  });

  app.delete("/api/v1/service-principals/:principalId/tokens/:tokenId", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const revokedByUserId = await activeUser(c.env, c.req.header("x-lifespace-actor-user-id")?.trim() || null);
    const result = await c.env.DB.prepare(`UPDATE service_api_tokens SET revoked_at=?,revoked_by_user_id=?
      WHERE id=? AND principal_id=? AND revoked_at IS NULL`).bind(now(), revokedByUserId, c.req.param("tokenId"), principal.id).run();
    if (!result.meta.changes) return c.json(fail("SERVICE_TOKEN_NOT_FOUND", "Active service token not found", c.get("requestId")), 404);
    return c.body(null, 204);
  });

  app.post("/api/v1/service-principals/:principalId/oauth-credentials", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    if (principal.status !== "active") return c.json(fail("SERVICE_PRINCIPAL_DISABLED", "Service principal is disabled", c.get("requestId")), 409);
    const body = await parseJsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    try {
      const label = text(body.label, "label", 100) as string;
      const createdByUserId = await activeUser(c.env, body.createdByUserId);
      const secret = randomSecret(OAUTH_SECRET_PREFIX);
      const credentialId = createId("soc");
      await c.env.DB.prepare(`INSERT INTO service_oauth_credentials(id,principal_id,secret_hash,secret_suffix,label,created_at,created_by_user_id)
        VALUES(?,?,?,?,?,?,?)`).bind(credentialId, principal.id, await sha256(secret), secret.slice(-8), label, now(), createdByUserId).run();
      const row = await c.env.DB.prepare(`SELECT id,principal_id,secret_suffix,label,status,created_at,created_by_user_id,last_used_at,revoked_at
        FROM service_oauth_credentials WHERE id=?`).bind(credentialId).first<OAuthCredentialRow>();
      if (!row) throw new Error("OAuth credential metadata missing after creation");
      return c.json(ok({ ...oauthCredentialDto(row), clientId: principal.id, clientSecret: secret }), 201);
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid OAuth credential request", c.get("requestId")), 422);
    }
  });

  app.get("/api/v1/service-principals/:principalId/oauth-credentials", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,principal_id,secret_suffix,label,status,created_at,created_by_user_id,last_used_at,revoked_at
      FROM service_oauth_credentials WHERE principal_id=? ORDER BY created_at DESC`).bind(principal.id).all<OAuthCredentialRow>();
    return c.json(ok(rows.results.map(oauthCredentialDto)));
  });

  app.delete("/api/v1/service-principals/:principalId/oauth-credentials/:credentialId", async (c) => {
    const application = await requireTrustedApplication(c);
    if (application instanceof Response) return application;
    const principal = await principalForApplication(c.env, c.req.param("principalId"), application.id);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const revokedByUserId = await activeUser(c.env, c.req.header("x-lifespace-actor-user-id")?.trim() || null);
    const result = await c.env.DB.prepare(`UPDATE service_oauth_credentials SET status='revoked',revoked_at=?,revoked_by_user_id=?
      WHERE id=? AND principal_id=? AND status='active'`).bind(now(), revokedByUserId, c.req.param("credentialId"), principal.id).run();
    if (!result.meta.changes) return c.json(fail("OAUTH_CREDENTIAL_NOT_FOUND", "Active OAuth credential not found", c.get("requestId")), 404);
    return c.body(null, 204);
  });

  app.post("/oauth/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) return oauthError(c, 400, "invalid_request", "Form-encoded request is required");
    const form = await c.req.parseBody<Record<string, string>>().catch(() => null);
    if (!form || form.grant_type !== "client_credentials") return oauthError(c, 400, "unsupported_grant_type", "grant_type must be client_credentials");
    let clientId = typeof form.client_id === "string" ? form.client_id : "";
    let clientSecret = typeof form.client_secret === "string" ? form.client_secret : "";
    const authorization = c.req.header("authorization");
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = atob(authorization.slice(6));
        const separator = decoded.indexOf(":");
        if (separator >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      } catch {
        return oauthError(c, 401, "invalid_client", "Client authentication failed");
      }
    }
    if (!clientId.startsWith("svc_") || !clientSecret.startsWith(OAUTH_SECRET_PREFIX)) return oauthError(c, 401, "invalid_client", "Client authentication failed");
    const credential = await c.env.DB.prepare(`SELECT oc.id credentialId,oc.secret_hash secretHash,sp.id principalId,sp.application_id applicationId,
        sp.max_scopes maxScopes,sp.status principalStatus,a.allowed_scopes allowedScopes,a.status applicationStatus,a.access_token_ttl_seconds ttl
      FROM service_oauth_credentials oc JOIN service_principals sp ON sp.id=oc.principal_id JOIN applications a ON a.id=sp.application_id
      WHERE sp.id=? AND oc.status='active' AND oc.revoked_at IS NULL`).bind(clientId).first<{
        credentialId: string; secretHash: string; principalId: string; applicationId: string; maxScopes: string; principalStatus: string;
        allowedScopes: string; applicationStatus: string; ttl: number;
      }>();
    if (!credential || credential.principalStatus !== "active" || credential.applicationStatus !== "active" || !await matchesStoredHash(clientSecret, credential.secretHash)) {
      return oauthError(c, 401, "invalid_client", "Client authentication failed");
    }
    const requested = typeof form.scope === "string" && form.scope.trim() ? form.scope.trim().split(/\s+/) : [];
    const principalScopes = parseJsonArray(credential.maxScopes);
    const applicationScopes = parseJsonArray(credential.allowedScopes);
    if (!scopeSubset(requested, principalScopes) || !scopeSubset(requested, applicationScopes)) return oauthError(c, 400, "invalid_scope", "Requested scope exceeds the current scope ceiling");
    if (!c.env.TOKEN_PRIVATE_KEY) return oauthError(c, 400, "server_error", "Identity signing key is unavailable");
    const iat = Math.floor(Date.now() / 1000);
    const jti = createId("tok");
    const accessToken = await sign({
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      sub: credential.principalId,
      azp: credential.applicationId,
      principal_type: "service",
      scope: requested.join(" "),
      iat,
      exp: iat + credential.ttl,
      jti,
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");
    deferOperationalWrite(
      c,
      c.env.DB.prepare("UPDATE service_oauth_credentials SET last_used_at=? WHERE id=?").bind(now(), credential.credentialId).run(),
    );
    return c.json({ access_token: accessToken, token_type: "Bearer", expires_in: credential.ttl, scope: requested.join(" ") });
  });

  app.post("/introspection/v1/service-tokens", async (c) => {
    const sharedSecret = c.req.header("x-lifespace-internal-secret") ?? "";
    if (!c.env.CORE_IDENTITY_SHARED_SECRET || !sharedSecret || !await constantTimeEqual(sharedSecret, c.env.CORE_IDENTITY_SHARED_SECRET)) {
      return c.json(fail("UNAUTHORIZED", "Internal service authentication is required", c.get("requestId")), 401);
    }
    const authorization = c.req.header("authorization");
    const plaintext = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!isOpaqueServiceApiToken(plaintext) || plaintext.length < 40) return c.json(ok({ active: false }));
    const tokenHash = await sha256(plaintext);
    const row = await measurePerformancePhase(c, "identity.service_token_lookup", () =>
      c.env.DB.prepare(`SELECT t.id tokenId,t.principal_id principalId,t.scopes,t.audience,t.expires_at expiresAt,t.revoked_at revokedAt,
          sp.application_id applicationId,sp.display_name displayName,sp.max_scopes maxScopes,sp.status principalStatus,a.allowed_scopes allowedScopes,a.status applicationStatus
        FROM service_api_tokens t JOIN service_principals sp ON sp.id=t.principal_id JOIN applications a ON a.id=sp.application_id
        WHERE t.token_hash_version=? AND t.token_hash=?`).bind(TOKEN_HASH_VERSION, tokenHash).first<{
          tokenId: string; principalId: string; scopes: string; audience: string; expiresAt: string | null; revokedAt: string | null;
          applicationId: string; displayName: string; maxScopes: string; principalStatus: string; allowedScopes: string; applicationStatus: string;
        }>(),
    );
    if (!row || row.revokedAt || row.principalStatus !== "active" || row.applicationStatus !== "active" || row.audience !== TOKEN_AUDIENCE || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) {
      return c.json(ok({ active: false }));
    }
    const scopes = parseJsonArray(row.scopes);
    if (!scopeSubset(scopes, parseJsonArray(row.maxScopes)) || !scopeSubset(scopes, parseJsonArray(row.allowedScopes))) return c.json(ok({ active: false }));
    deferOperationalWrite(
      c,
      c.env.DB.prepare("UPDATE service_api_tokens SET last_used_at=? WHERE id=?").bind(now(), row.tokenId).run(),
    );
    return c.json(ok({
      active: true,
      principal: { type: "service", id: row.principalId, displayName: row.displayName, clientId: row.applicationId, scopes, tokenId: row.tokenId },
      audience: row.audience,
    }));
  });
}
