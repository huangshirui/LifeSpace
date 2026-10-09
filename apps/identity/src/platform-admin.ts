import type { Context, Hono } from "hono";
import { configuredAccessIssuer } from "./access-auth";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  hashApplicationSecret,
  newApplicationSecret,
  validApplicationTokenTtl,
} from "./application-admin";
import type { Bindings, UserPrincipal, Variables } from "./env";
import { requirePlatformAdminActor } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type ApplicationRow = {
  id: string;
  name: string;
  allowed_scopes: string;
  trusted_backend: number;
  access_token_ttl_seconds: number;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

type CredentialRow = {
  id: string;
  application_id: string;
  secret_suffix: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
};

type AudienceRow = {
  id: string;
  application_id: string;
  issuer: string;
  audience: string;
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
};

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

function parseScopes(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)) return null;
  const scopes = value.map((entry) => (entry as string).trim());
  return new Set(scopes).size === scopes.length ? scopes : null;
}

function applicationDto(row: ApplicationRow) {
  return {
    id: row.id,
    name: row.name,
    allowedScopes: parseScopes(row.allowed_scopes),
    trustedBackend: row.trusted_backend === 1,
    accessTokenTtlSeconds: row.access_token_ttl_seconds,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialDto(row: CredentialRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    secretSuffix: row.secret_suffix,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function audienceDto(row: AudienceRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    issuer: row.issuer,
    audience: row.audience,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

async function loadApplication(db: D1Database, applicationId: string): Promise<ApplicationRow | null> {
  return db.prepare(`SELECT id,name,allowed_scopes,trusted_backend,access_token_ttl_seconds,status,created_at,updated_at
    FROM applications WHERE id=?`).bind(applicationId).first<ApplicationRow>();
}

function targetApplicationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value)) throw new Error("applicationId is invalid");
  return value;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const value = await c.req.json<unknown>().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

async function admin(c: Context<AppEnv>, scope = "applications:manage"): Promise<UserPrincipal | Response> {
  return requirePlatformAdminActor(c, scope);
}

export function registerPlatformAdminRoutes(app: App): void {
  app.get("/internal/v1/platform-admin/applications", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const rows = await c.env.DB.prepare(`SELECT id,name,allowed_scopes,trusted_backend,access_token_ttl_seconds,status,created_at,updated_at
      FROM applications ORDER BY created_at,id`).all<ApplicationRow>();
    return c.json(ok(rows.results.map(applicationDto)));
  });

  app.post("/internal/v1/platform-admin/applications", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    const allowedKeys = new Set(["name", "allowedScopes", "trustedBackend", "accessTokenTtlSeconds"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return c.json(fail("INVALID_REQUEST", "Application request contains unsupported fields", c.get("requestId")), 400);
    }
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) {
      return c.json(fail("VALIDATION_ERROR", "name must contain 1-100 characters", c.get("requestId")), 422);
    }
    const scopes = normalizeScopes(body.allowedScopes ?? []);
    if (!scopes) return c.json(fail("VALIDATION_ERROR", "allowedScopes must contain unique non-empty scope strings", c.get("requestId")), 422);
    if (body.trustedBackend !== undefined && typeof body.trustedBackend !== "boolean") {
      return c.json(fail("VALIDATION_ERROR", "trustedBackend must be boolean", c.get("requestId")), 422);
    }
    const ttl = body.accessTokenTtlSeconds === undefined ? DEFAULT_ACCESS_TOKEN_TTL_SECONDS : body.accessTokenTtlSeconds;
    if (typeof ttl !== "number" || !validApplicationTokenTtl(ttl)) {
      return c.json(fail("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", c.get("requestId")), 422);
    }

    const applicationId = id("app");
    const trustedBackend = body.trustedBackend === true;
    const clientSecret = trustedBackend ? newApplicationSecret() : null;
    const timestamp = now();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(`INSERT INTO applications(id,name,allowed_scopes,trusted_backend,access_token_ttl_seconds,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).bind(applicationId, body.name.trim(), JSON.stringify(scopes), trustedBackend ? 1 : 0, ttl, timestamp, timestamp),
    ];
    let credential: CredentialRow | null = null;
    if (clientSecret) {
      credential = { id: id("apc"), application_id: applicationId, secret_suffix: clientSecret.slice(-8), status: "active", created_at: timestamp, revoked_at: null };
      statements.push(c.env.DB.prepare(`INSERT INTO application_credentials(id,application_id,secret_hash,secret_suffix,status,created_at,revoked_at)
        VALUES(?,?,?,?,?,?,NULL)`).bind(credential.id, applicationId, await hashApplicationSecret(clientSecret), credential.secret_suffix, "active", timestamp));
    }
    statements.push(auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "application.create", "application", applicationId, {
      name: body.name.trim(), allowedScopes: scopes, trustedBackend, accessTokenTtlSeconds: ttl,
    }));
    await c.env.DB.batch(statements);
    const row = await loadApplication(c.env.DB, applicationId);
    if (!row) throw new Error("Application missing after creation");
    return c.json(ok({ ...applicationDto(row), ...(credential && clientSecret ? { credential: credentialDto(credential), clientSecret } : {}) }), 201);
  });

  app.get("/internal/v1/platform-admin/applications/:applicationId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    let applicationId: string;
    try { applicationId = targetApplicationId(c.req.param("applicationId")); }
    catch { return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422); }
    const row = await loadApplication(c.env.DB, applicationId);
    if (!row) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    return c.json(ok(applicationDto(row)));
  });

  app.patch("/internal/v1/platform-admin/applications/:applicationId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    let applicationId: string;
    try { applicationId = targetApplicationId(c.req.param("applicationId")); }
    catch { return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422); }
    const previous = await loadApplication(c.env.DB, applicationId);
    if (!previous) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const body = await jsonBody(c);
    if (!body) return c.json(fail("INVALID_REQUEST", "JSON body is required", c.get("requestId")), 400);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["name", "allowedScopes", "accessTokenTtlSeconds", "status"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Only name, allowedScopes, accessTokenTtlSeconds and status may be updated", c.get("requestId")), 400);
    }
    const name = body.name === undefined ? previous.name : typeof body.name === "string" && body.name.trim() && body.name.trim().length <= 100 ? body.name.trim() : null;
    if (!name) return c.json(fail("VALIDATION_ERROR", "name must contain 1-100 characters", c.get("requestId")), 422);
    const scopes = body.allowedScopes === undefined ? parseScopes(previous.allowed_scopes) : normalizeScopes(body.allowedScopes);
    if (!scopes) return c.json(fail("VALIDATION_ERROR", "allowedScopes must contain unique non-empty scope strings", c.get("requestId")), 422);
    const ttl = body.accessTokenTtlSeconds === undefined ? previous.access_token_ttl_seconds : body.accessTokenTtlSeconds;
    if (typeof ttl !== "number" || !validApplicationTokenTtl(ttl)) return c.json(fail("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", c.get("requestId")), 422);
    const status = body.status === undefined ? previous.status : body.status;
    if (status !== "active" && status !== "disabled") return c.json(fail("VALIDATION_ERROR", "status must be active or disabled", c.get("requestId")), 422);
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE applications SET name=?,allowed_scopes=?,access_token_ttl_seconds=?,status=?,updated_at=? WHERE id=?")
        .bind(name, JSON.stringify(scopes), ttl, status, timestamp, applicationId),
      auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "application.update", "application", applicationId, {
        name, allowedScopes: scopes, accessTokenTtlSeconds: ttl, status,
      }),
    ]);
    const updated = await loadApplication(c.env.DB, applicationId);
    if (!updated) throw new Error("Application missing after update");
    return c.json(ok(applicationDto(updated)));
  });

  app.get("/internal/v1/platform-admin/applications/:applicationId/credentials", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!await loadApplication(c.env.DB, applicationId)) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,application_id,secret_suffix,status,created_at,revoked_at
      FROM application_credentials WHERE application_id=? ORDER BY created_at,id`).bind(applicationId).all<CredentialRow>();
    return c.json(ok(rows.results.map(credentialDto)));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/credentials", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const application = await loadApplication(c.env.DB, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.trusted_backend !== 1 || application.status !== "active") {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Application must be an active trusted backend", c.get("requestId")), 409);
    }
    const clientSecret = newApplicationSecret();
    const timestamp = now();
    const row: CredentialRow = { id: id("apc"), application_id: applicationId, secret_suffix: clientSecret.slice(-8), status: "active", created_at: timestamp, revoked_at: null };
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO application_credentials(id,application_id,secret_hash,secret_suffix,status,created_at,revoked_at)
        VALUES(?,?,?,?,?,?,NULL)`).bind(row.id, applicationId, await hashApplicationSecret(clientSecret), row.secret_suffix, row.status, timestamp),
      auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "application_credential.create", "application_credential", row.id, { applicationId, secretSuffix: row.secret_suffix }),
    ]);
    return c.json(ok({ ...credentialDto(row), clientSecret }), 201);
  });

  app.delete("/internal/v1/platform-admin/applications/:applicationId/credentials/:credentialId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const credentialId = c.req.param("credentialId");
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE application_credentials SET status='revoked',revoked_at=?
      WHERE id=? AND application_id=? AND status='active' AND revoked_at IS NULL`).bind(revokedAt, credentialId, applicationId).run();
    if (!result.meta.changes) return c.json(fail("APPLICATION_CREDENTIAL_NOT_FOUND", "Active application credential not found", c.get("requestId")), 404);
    await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "application_credential.revoke", "application_credential", credentialId, { applicationId }).run();
    return c.body(null, 204);
  });

  app.get("/internal/v1/platform-admin/applications/:applicationId/access-audiences", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!await loadApplication(c.env.DB, applicationId)) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT id,application_id,issuer,audience,status,created_at,revoked_at
      FROM access_audiences WHERE application_id=? ORDER BY created_at,id`).bind(applicationId).all<AudienceRow>();
    return c.json(ok(rows.results.map(audienceDto)));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/access-audiences", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const application = await loadApplication(c.env.DB, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.trusted_backend !== 1 || application.status !== "active") {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Access audiences require an active trusted application backend", c.get("requestId")), 409);
    }
    const body = await jsonBody(c);
    const audience = typeof body?.audience === "string" ? body.audience.trim() : "";
    if (!audience || audience.length > 256 || /\s/u.test(audience) || Object.keys(body ?? {}).some((key) => key !== "audience")) {
      return c.json(fail("VALIDATION_ERROR", "audience must be a non-empty token without whitespace", c.get("requestId")), 422);
    }
    let issuer: string;
    try { issuer = configuredAccessIssuer(c.env.ACCESS_TEAM_DOMAIN); }
    catch { return c.json(fail("ACCESS_NOT_CONFIGURED", "Cloudflare Access verification is not configured", c.get("requestId")), 500); }

    const existing = await c.env.DB.prepare(`SELECT id,application_id,issuer,audience,status,created_at,revoked_at
      FROM access_audiences WHERE issuer=? AND audience=? AND status='active'`).bind(issuer, audience).first<AudienceRow>();
    if (existing) {
      if (existing.application_id !== applicationId) {
        return c.json(fail("ACCESS_AUDIENCE_IN_USE", "Access audience is already registered to another application", c.get("requestId")), 409);
      }
      return c.json(ok(audienceDto(existing)));
    }

    const row: AudienceRow = { id: id("aud"), application_id: applicationId, issuer, audience, status: "active", created_at: now(), revoked_at: null };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO access_audiences(id,application_id,issuer,audience,status,created_at,revoked_at)
          VALUES(?,?,?,?,?,?,NULL)`).bind(row.id, applicationId, issuer, audience, "active", row.created_at),
        auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "access_audience.create", "access_audience", row.id, { applicationId, issuer, audience }),
      ]);
    } catch (error) {
      const raced = await c.env.DB.prepare(`SELECT id,application_id,issuer,audience,status,created_at,revoked_at
        FROM access_audiences WHERE issuer=? AND audience=? AND status='active'`).bind(issuer, audience).first<AudienceRow>();
      if (raced) {
        if (raced.application_id !== applicationId) {
          return c.json(fail("ACCESS_AUDIENCE_IN_USE", "Access audience became registered to another application concurrently", c.get("requestId")), 409);
        }
        return c.json(ok(audienceDto(raced)));
      }
      throw error;
    }
    return c.json(ok(audienceDto(row)), 201);
  });

  app.delete("/internal/v1/platform-admin/applications/:applicationId/access-audiences/:audienceId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const audienceId = c.req.param("audienceId");
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE access_audiences SET status='revoked',revoked_at=?
      WHERE id=? AND application_id=? AND status='active'`).bind(revokedAt, audienceId, applicationId).run();
    if (!result.meta.changes) return c.json(fail("ACCESS_AUDIENCE_NOT_FOUND", "Active Access audience registration not found", c.get("requestId")), 404);
    await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "access_audience.revoke", "access_audience", audienceId, { applicationId }).run();
    return c.body(null, 204);
  });

  app.get("/internal/v1/platform-admin/audit", async (c) => {
    const actor = await admin(c, "audit:read");
    if (actor instanceof Response) return actor;
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json(fail("VALIDATION_ERROR", "limit must be an integer between 1 and 200", c.get("requestId")), 422);
    const rows = await c.env.DB.prepare(`SELECT id,actor_user_id actorUserId,actor_application_id actorApplicationId,
      executor_application_id executorApplicationId,operation,target_type targetType,target_id targetId,
      summary_json summaryJson,request_id requestId,result,created_at createdAt
      FROM platform_admin_audit ORDER BY created_at DESC,id DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
    return c.json(ok(rows.results.map((row) => ({ ...row, summary: JSON.parse(String(row.summaryJson ?? "{}")), summaryJson: undefined }))));
  });
}
