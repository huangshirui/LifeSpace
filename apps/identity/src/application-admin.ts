import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };

type ApplicationRow = {
  id: string;
  name: string;
  allowed_scopes: string;
  trusted_backend: number;
  access_token_ttl_seconds: number;
  status: string;
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

type UpdateApplicationBody = {
  name?: unknown;
  allowedScopes?: unknown;
  accessTokenTtlSeconds?: unknown;
  status?: unknown;
};

export const IDENTITY_CONTRACT_VERSION = "0.17.0";
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
export const MIN_ACCESS_TOKEN_TTL_SECONDS = 300;
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 3600;

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function hashApplicationSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newApplicationSecret(): string {
  return `lsa_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function validApplicationTokenTtl(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_ACCESS_TOKEN_TTL_SECONDS && value <= MAX_ACCESS_TOKEN_TTL_SECONDS;
}

function parseScopes(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored application scopes are invalid");
  }
  return parsed;
}

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)) return null;
  const scopes = value.map((entry) => (entry as string).trim());
  if (new Set(scopes).size !== scopes.length) return null;
  return scopes;
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

async function loadApplication(db: D1Database, applicationId: string): Promise<ApplicationRow | null> {
  return db.prepare(`
    SELECT id,name,allowed_scopes,trusted_backend,access_token_ttl_seconds,status,created_at,updated_at
    FROM applications WHERE id=?
  `).bind(applicationId).first<ApplicationRow>();
}

export function registerApplicationAdminRoutes(app: Hono<AppEnv>) {
  // Ordinary application-plane introspection is scoped exclusively to the
  // already authenticated lsa_* application. It does not manage other apps,
  // create credentials, or elevate a CI caller into Platform Admin authority.
  app.get("/internal/v1/applications/self", async (c) => {
    const applicationId = c.get("currentApplicationId");
    const row = await loadApplication(c.env.DB, applicationId);
    if (!row || row.status !== "active" || row.trusted_backend !== 1) {
      return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
    }
    return c.json(ok(applicationDto(row)));
  });

  app.get("/bootstrap/v1/applications/:applicationId", async (c) => {
    const row = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!row) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    return c.json(ok(applicationDto(row)));
  });

  app.patch("/bootstrap/v1/applications/:applicationId", async (c) => {
    const input = await c.req.json<UpdateApplicationBody>().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return c.json(fail("INVALID_REQUEST", "Application update body is required", c.get("requestId")), 400);
    }
    const keys = Object.keys(input);
    const allowedKeys = new Set(["name", "allowedScopes", "accessTokenTtlSeconds", "status"]);
    if (!keys.length || keys.some((key) => !allowedKeys.has(key))) {
      return c.json(fail("INVALID_REQUEST", "Only name, allowedScopes, accessTokenTtlSeconds and status may be updated", c.get("requestId")), 400);
    }

    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if ("name" in input) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) {
        return c.json(fail("VALIDATION_ERROR", "name must contain 1-100 characters", c.get("requestId")), 422);
      }
      assignments.push("name=?");
      values.push(input.name.trim());
    }
    if ("allowedScopes" in input) {
      const scopes = normalizeScopes(input.allowedScopes);
      if (!scopes) return c.json(fail("VALIDATION_ERROR", "allowedScopes must contain unique non-empty scope strings", c.get("requestId")), 422);
      assignments.push("allowed_scopes=?");
      values.push(JSON.stringify(scopes));
    }
    if ("accessTokenTtlSeconds" in input) {
      if (typeof input.accessTokenTtlSeconds !== "number" || !validApplicationTokenTtl(input.accessTokenTtlSeconds)) {
        return c.json(fail("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", c.get("requestId")), 422);
      }
      assignments.push("access_token_ttl_seconds=?");
      values.push(input.accessTokenTtlSeconds);
    }
    if ("status" in input) {
      if (input.status !== "active" && input.status !== "disabled") {
        return c.json(fail("VALIDATION_ERROR", "status must be active or disabled", c.get("requestId")), 422);
      }
      assignments.push("status=?");
      values.push(input.status);
    }

    const updatedAt = new Date().toISOString();
    assignments.push("updated_at=?");
    values.push(updatedAt, c.req.param("applicationId"));
    const result = await c.env.DB.prepare(`UPDATE applications SET ${assignments.join(",")} WHERE id=?`).bind(...values).run();
    if (!result.meta.changes) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const row = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!row) throw new Error("Application missing after update");
    return c.json(ok(applicationDto(row)));
  });

  app.get("/bootstrap/v1/applications/:applicationId/credentials", async (c) => {
    const application = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const result = await c.env.DB.prepare(`
      SELECT id,application_id,secret_suffix,status,created_at,revoked_at
      FROM application_credentials WHERE application_id=? ORDER BY created_at,id
    `).bind(application.id).all<CredentialRow>();
    return c.json(ok(result.results.map(credentialDto)));
  });

  app.post("/bootstrap/v1/applications/:applicationId/credentials", async (c) => {
    const application = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.trusted_backend !== 1) {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Application is not a trusted backend", c.get("requestId")), 409);
    }
    if (application.status !== "active") {
      return c.json(fail("APPLICATION_DISABLED", "Application is disabled", c.get("requestId")), 409);
    }

    const clientSecret = newApplicationSecret();
    const row: CredentialRow = {
      id: id("apc"),
      application_id: application.id,
      secret_suffix: clientSecret.slice(-8),
      status: "active",
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    await c.env.DB.prepare(`
      INSERT INTO application_credentials(id,application_id,secret_hash,secret_suffix,status,created_at,revoked_at)
      VALUES(?,?,?,?,?,?,NULL)
    `).bind(row.id, row.application_id, await hashApplicationSecret(clientSecret), row.secret_suffix, row.status, row.created_at).run();
    return c.json(ok({ ...credentialDto(row), clientSecret }), 201);
  });

  app.delete("/bootstrap/v1/applications/:applicationId/credentials/:credentialId", async (c) => {
    const revokedAt = new Date().toISOString();
    const result = await c.env.DB.prepare(`
      UPDATE application_credentials
      SET status='revoked',revoked_at=?
      WHERE id=? AND application_id=? AND status='active' AND revoked_at IS NULL
    `).bind(revokedAt, c.req.param("credentialId"), c.req.param("applicationId")).run();
    if (!result.meta.changes) {
      return c.json(fail("APPLICATION_CREDENTIAL_NOT_FOUND", "Active application credential not found", c.get("requestId")), 404);
    }
    return c.body(null, 204);
  });
}
