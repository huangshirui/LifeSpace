import type { Context, Hono } from "hono";
import type { Bindings, UserPrincipal, Variables } from "./env";
import { requirePlatformAdminActor } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type ApplicationRow = {
  id: string;
  allowed_scopes: string;
  status: "active" | "disabled";
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

const SERVICE_TOKEN_PREFIX = "lsp_pat_";
const SERVICE_TOKEN_AUDIENCE = "lifespace-core";
const TOKEN_HASH_VERSION = 1;
const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

function validApplicationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value);
}

function validPrincipalId(value: string): boolean {
  return /^svc_[A-Za-z0-9_-]+$/u.test(value);
}

function validTokenId(value: string): boolean {
  return /^sat_[A-Za-z0-9_-]+$/u.test(value);
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeScopes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !scope.trim() || scope.trim().length > 100)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  const scopes = value.map((scope) => (scope as string).trim());
  if (new Set(scopes).size !== scopes.length) throw new Error(`${field} must not contain duplicates`);
  return scopes;
}

function scopeSubset(requested: string[], ceiling: string[]): boolean {
  return requested.every((scope) => ceiling.includes(scope));
}

function text(value: unknown, field: string, maxLength: number, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${field} is invalid`);
  return value.trim();
}

function parseInstantOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an RFC 3339 UTC instant or null`);
  }
  if (Date.parse(value) <= Date.now()) throw new Error(`${field} must be in the future`);
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${prefix}${raw}`;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const value = await c.req.json<unknown>().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function loadApplication(env: Bindings, applicationId: string): Promise<ApplicationRow | null> {
  return env.DB.prepare("SELECT id,allowed_scopes,status FROM applications WHERE id=?")
    .bind(applicationId).first<ApplicationRow>();
}

async function loadPrincipal(env: Bindings, applicationId: string, principalId: string): Promise<ServicePrincipalRow | null> {
  return env.DB.prepare(`SELECT id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
    FROM service_principals WHERE id=? AND application_id=?`).bind(principalId, applicationId).first<ServicePrincipalRow>();
}

async function loadToken(env: Bindings, principalId: string, tokenId: string): Promise<ServiceTokenRow | null> {
  return env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
    FROM service_api_tokens WHERE id=? AND principal_id=?`).bind(tokenId, principalId).first<ServiceTokenRow>();
}

function principalDto(row: ServicePrincipalRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
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

function auditStatement(
  env: Bindings,
  actor: UserPrincipal,
  executorApplicationId: string,
  requestId: string,
  operation: string,
  targetType: string,
  targetId: string,
  summary: unknown,
) {
  return env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,executor_application_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id("paa"), actor.id, actor.clientId, actor.tokenId, executorApplicationId,
    operation, targetType, targetId, JSON.stringify(summary), requestId, "success", now(),
  );
}

async function admin(c: Context<AppEnv>): Promise<UserPrincipal | Response> {
  return requirePlatformAdminActor(c, "services:manage");
}

export function registerPlatformServiceAdminRoutes(app: App): void {
  app.get("/internal/v1/platform-admin/applications/:applicationId/service-principals", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!validApplicationId(applicationId)) return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422);
    if (!await loadApplication(c.env, applicationId)) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
      FROM service_principals WHERE application_id=? ORDER BY created_at DESC,id`).bind(applicationId).all<ServicePrincipalRow>();
    return c.json(ok(rows.results.map(principalDto)));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/service-principals", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!validApplicationId(applicationId)) return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422);
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.status !== "active") return c.json(fail("APPLICATION_DISABLED", "Application is disabled", c.get("requestId")), 409);
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    if (Object.keys(body).some((key) => !["displayName", "description", "maxScopes"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Unsupported service principal field", c.get("requestId")), 400);
    }
    try {
      const displayName = text(body.displayName, "displayName", 100) as string;
      const description = text(body.description, "description", 500, true);
      const maxScopes = normalizeScopes(body.maxScopes ?? [], "maxScopes");
      const applicationScopes = parseJsonArray(application.allowed_scopes);
      if (!scopeSubset(maxScopes, applicationScopes)) {
        return c.json(fail("FORBIDDEN", "Service principal scopes exceed the application scope ceiling", c.get("requestId")), 403);
      }
      const principalId = id("svc");
      const timestamp = now();
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO service_principals(
          id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at
        ) VALUES(?,?,?,?,?,'active',?,?,?,NULL)`).bind(
          principalId, applicationId, displayName, description, JSON.stringify(maxScopes), actor.id, timestamp, timestamp,
        ),
        auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "service_principal.create", "service_principal", principalId, {
          applicationId, displayName, description, maxScopes,
        }),
      ]);
      const row = await loadPrincipal(c.env, applicationId, principalId);
      if (!row) throw new Error("Service principal missing after creation");
      return c.json(ok(principalDto(row)), 201);
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service principal", c.get("requestId")), 422);
    }
  });

  app.get("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    if (!validApplicationId(applicationId) || !validPrincipalId(principalId)) return c.json(fail("VALIDATION_ERROR", "Application or principal id is invalid", c.get("requestId")), 422);
    const row = await loadPrincipal(c.env, applicationId, principalId);
    if (!row) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    return c.json(ok(principalDto(row)));
  });

  app.patch("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const previous = await loadPrincipal(c.env, applicationId, principalId);
    if (!previous) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["displayName", "description", "maxScopes", "status"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Unsupported service principal update", c.get("requestId")), 400);
    }
    try {
      const displayName = body.displayName === undefined ? previous.display_name : text(body.displayName, "displayName", 100) as string;
      const description = body.description === undefined ? previous.description : text(body.description, "description", 500, true);
      const maxScopes = body.maxScopes === undefined ? parseJsonArray(previous.max_scopes) : normalizeScopes(body.maxScopes, "maxScopes");
      if (!scopeSubset(maxScopes, parseJsonArray(application.allowed_scopes))) {
        return c.json(fail("FORBIDDEN", "Service principal scopes exceed the application scope ceiling", c.get("requestId")), 403);
      }
      const status = body.status === undefined ? previous.status : body.status;
      if (status !== "active" && status !== "disabled") throw new Error("status must be active or disabled");
      if (status === "active" && application.status !== "active") return c.json(fail("APPLICATION_DISABLED", "Disabled application cannot activate service principals", c.get("requestId")), 409);
      const timestamp = now();
      const disabledAt = status === "disabled" ? (previous.disabled_at ?? timestamp) : null;
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE service_principals SET display_name=?,description=?,max_scopes=?,status=?,updated_at=?,disabled_at=?
          WHERE id=? AND application_id=?`).bind(displayName, description, JSON.stringify(maxScopes), status, timestamp, disabledAt, principalId, applicationId),
        auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "service_principal.update", "service_principal", principalId, {
          applicationId, displayName, description, maxScopes, status,
        }),
      ]);
      const updated = await loadPrincipal(c.env, applicationId, principalId);
      if (!updated) throw new Error("Service principal missing after update");
      return c.json(ok(principalDto(updated)));
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service principal update", c.get("requestId")), 422);
    }
  });

  app.get("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId/tokens", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    const principal = await loadPrincipal(c.env, applicationId, principalId);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,principal_id,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id,last_used_at,revoked_at
      FROM service_api_tokens WHERE principal_id=? ORDER BY created_at DESC,id`).bind(principalId).all<ServiceTokenRow>();
    return c.json(ok(rows.results.map(tokenDto)));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId/tokens", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.status !== "active") return c.json(fail("APPLICATION_DISABLED", "Application is disabled", c.get("requestId")), 409);
    const principal = await loadPrincipal(c.env, applicationId, principalId);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    if (principal.status !== "active") return c.json(fail("SERVICE_PRINCIPAL_DISABLED", "Service principal is disabled", c.get("requestId")), 409);
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    if (Object.keys(body).some((key) => !["label", "scopes", "expiresAt"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Unsupported service token field", c.get("requestId")), 400);
    }
    try {
      const label = text(body.label, "label", 100) as string;
      const scopes = normalizeScopes(body.scopes ?? [], "scopes");
      if (!scopeSubset(scopes, parseJsonArray(principal.max_scopes)) || !scopeSubset(scopes, parseJsonArray(application.allowed_scopes))) {
        return c.json(fail("FORBIDDEN", "Token scopes exceed the current scope ceiling", c.get("requestId")), 403);
      }
      const expiresAt = parseInstantOrNull(body.expiresAt, "expiresAt");
      const token = randomSecret(SERVICE_TOKEN_PREFIX);
      const tokenId = id("sat");
      const timestamp = now();
      const displayPrefix = token.slice(0, 16);
      const lastFour = token.slice(-4);
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO service_api_tokens(
          id,principal_id,token_hash_version,token_hash,display_prefix,last_four,label,scopes,audience,expires_at,created_at,created_by_user_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          tokenId, principalId, TOKEN_HASH_VERSION, await sha256(token), displayPrefix, lastFour, label,
          JSON.stringify(scopes), SERVICE_TOKEN_AUDIENCE, expiresAt, timestamp, actor.id,
        ),
        auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "service_token.create", "service_token", tokenId, {
          applicationId, principalId, label, scopes, expiresAt, displayPrefix, lastFour,
        }),
      ]);
      const row = await loadToken(c.env, principalId, tokenId);
      if (!row) throw new Error("Service token missing after creation");
      return c.json(ok({ ...tokenDto(row), token }), 201);
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service token", c.get("requestId")), 422);
    }
  });

  app.patch("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId/tokens/:tokenId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    const tokenId = c.req.param("tokenId");
    if (!validTokenId(tokenId)) return c.json(fail("VALIDATION_ERROR", "tokenId is invalid", c.get("requestId")), 422);
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const principal = await loadPrincipal(c.env, applicationId, principalId);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const previous = await loadToken(c.env, principalId, tokenId);
    if (!previous || previous.revoked_at) return c.json(fail("SERVICE_TOKEN_NOT_FOUND", "Active service token not found", c.get("requestId")), 404);
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["label", "scopes", "expiresAt"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Unsupported service token update", c.get("requestId")), 400);
    }
    try {
      const label = body.label === undefined ? previous.label : text(body.label, "label", 100) as string;
      const priorScopes = parseJsonArray(previous.scopes);
      const scopes = body.scopes === undefined ? priorScopes : normalizeScopes(body.scopes, "scopes");
      if (!scopeSubset(scopes, priorScopes)) throw new Error("Token scopes may only be reduced");
      if (!scopeSubset(scopes, parseJsonArray(principal.max_scopes)) || !scopeSubset(scopes, parseJsonArray(application.allowed_scopes))) {
        return c.json(fail("FORBIDDEN", "Token scopes exceed the current scope ceiling", c.get("requestId")), 403);
      }
      const expiresAt = body.expiresAt === undefined ? previous.expires_at : parseInstantOrNull(body.expiresAt, "expiresAt");
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE service_api_tokens SET label=?,scopes=?,expires_at=? WHERE id=? AND principal_id=? AND revoked_at IS NULL")
          .bind(label, JSON.stringify(scopes), expiresAt, tokenId, principalId),
        auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "service_token.update", "service_token", tokenId, {
          applicationId, principalId, label, scopes, expiresAt,
        }),
      ]);
      const updated = await loadToken(c.env, principalId, tokenId);
      if (!updated) throw new Error("Service token missing after update");
      return c.json(ok(tokenDto(updated)));
    } catch (error) {
      return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid service token update", c.get("requestId")), 422);
    }
  });

  app.delete("/internal/v1/platform-admin/applications/:applicationId/service-principals/:principalId/tokens/:tokenId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const principalId = c.req.param("principalId");
    const tokenId = c.req.param("tokenId");
    const principal = await loadPrincipal(c.env, applicationId, principalId);
    if (!principal) return c.json(fail("SERVICE_PRINCIPAL_NOT_FOUND", "Service principal not found", c.get("requestId")), 404);
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE service_api_tokens SET revoked_at=?,revoked_by_user_id=?
      WHERE id=? AND principal_id=? AND revoked_at IS NULL`).bind(revokedAt, actor.id, tokenId, principalId).run();
    if (!result.meta.changes) return c.json(fail("SERVICE_TOKEN_NOT_FOUND", "Active service token not found", c.get("requestId")), 404);
    await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "service_token.revoke", "service_token", tokenId, {
      applicationId, principalId, revokedAt,
    }).run();
    return c.body(null, 204);
  });
}
