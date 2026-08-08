import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type UserBody = { displayName?: string };
type ApplicationBody = {
  id?: string;
  name?: string;
  clientType?: string;
  allowedScopes?: string[];
  trustedBackend?: boolean;
};
type TokenBody = { subjectId?: string; scopes?: string[] };

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newApplicationSecret(): string {
  return `lsa_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.trim() || crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
  });

  app.use("/bootstrap/*", async (c, next) => {
    if (!c.env.BOOTSTRAP_SECRET || c.req.header("x-bootstrap-secret") !== c.env.BOOTSTRAP_SECRET) {
      return c.json(fail("UNAUTHORIZED", "Bootstrap authentication is required", c.get("requestId")), 401);
    }
    await next();
  });

  app.use("/internal/*", async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
    }
    const secret = authorization.slice(7).trim();
    if (!secret.startsWith("lsa_") || secret.length < 40) {
      return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
    }
    const secretHash = await sha256(secret);
    const credential = await c.env.DB.prepare(`
      SELECT c.application_id applicationId, a.allowed_scopes allowedScopes
      FROM application_credentials c
      JOIN applications a ON a.id = c.application_id
      WHERE c.secret_hash = ?
        AND c.status = 'active'
        AND c.revoked_at IS NULL
        AND a.status = 'active'
        AND a.trusted_backend = 1
    `).bind(secretHash).first<{ applicationId: string; allowedScopes: string }>();
    if (!credential) {
      return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
    }
    c.set("currentApplicationId", credential.applicationId);
    c.set("currentApplicationScopes", JSON.parse(credential.allowedScopes) as string[]);
    await next();
  });

  app.get("/health", (c) => c.json(ok({ status: "ok" })));

  app.get("/api/v1/status", async (c) => {
    const row = await c.env.DB.prepare(`SELECT value FROM schema_metadata WHERE key='schema_version'`).first<{ value: string }>();
    if (!row) throw new Error("schema version metadata is missing");
    return c.json(ok({
      status: "ok",
      service: "identity",
      environment: c.env.ENVIRONMENT ?? "local",
      database: "available",
      schemaVersion: row.value,
      contractVersion: "0.1.1",
    }));
  });

  app.post("/bootstrap/v1/applications", async (c) => {
    const body = (await c.req.json<ApplicationBody>().catch(() => ({}))) as ApplicationBody;
    if (!body.id || !body.name || !body.clientType || !["web", "mini_program", "service", "device"].includes(body.clientType)) {
      return c.json(fail("VALIDATION_ERROR", "id, name and valid clientType are required", c.get("requestId")), 422);
    }
    const ts = new Date().toISOString();
    const trustedBackend = body.trustedBackend === true;
    const allowedScopes = body.allowedScopes ?? [];
    const secret = trustedBackend ? newApplicationSecret() : null;

    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`
          INSERT INTO applications(id,name,client_type,allowed_scopes,trusted_backend,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
        `).bind(body.id, body.name, body.clientType, JSON.stringify(allowedScopes), trustedBackend ? 1 : 0, ts, ts),
        ...(secret ? [c.env.DB.prepare(`
          INSERT INTO application_credentials(id,application_id,secret_hash,secret_suffix,created_at)
          VALUES(?,?,?,?,?)
        `).bind(id("apc"), body.id, await sha256(secret), secret.slice(-8), ts)] : []),
      ]);
    } catch (error) {
      console.error("Application bootstrap failed", { requestId: c.get("requestId"), applicationId: body.id, error });
      return c.json(fail("CONFLICT", "Application could not be registered", c.get("requestId")), 409);
    }

    return c.json(ok({
      id: body.id,
      name: body.name,
      trustedBackend,
      allowedScopes,
      ...(secret ? { clientSecret: secret } : {}),
    }), 201);
  });

  app.post("/internal/v1/users", async (c) => {
    const body = (await c.req.json<UserBody>().catch(() => ({}))) as UserBody;
    if (!body.displayName?.trim()) {
      return c.json(fail("VALIDATION_ERROR", "displayName is required", c.get("requestId")), 422);
    }
    const userId = id("usr");
    const ts = new Date().toISOString();
    await c.env.DB.prepare(`INSERT INTO users(id,display_name,created_at,updated_at) VALUES(?,?,?,?)`)
      .bind(userId, body.displayName.trim(), ts, ts).run();
    return c.json(ok({ id: userId, displayName: body.displayName.trim() }), 201);
  });

  app.post("/internal/v1/tokens", async (c) => {
    const body = (await c.req.json<TokenBody>().catch(() => ({}))) as TokenBody;
    if (!body.subjectId) {
      return c.json(fail("VALIDATION_ERROR", "subjectId is required", c.get("requestId")), 422);
    }

    const user = await c.env.DB.prepare(`SELECT status FROM users WHERE id=?`)
      .bind(body.subjectId).first<{ status: string }>();
    if (!user || user.status !== "active") {
      return c.json(fail("FORBIDDEN", "User is not active", c.get("requestId")), 403);
    }

    const allowed = c.get("currentApplicationScopes");
    const requested = body.scopes ?? [];
    if (requested.some((scope) => !allowed.includes(scope))) {
      return c.json(fail("FORBIDDEN", "Requested scope is not allowed for this application", c.get("requestId")), 403);
    }
    if (!c.env.TOKEN_PRIVATE_KEY) {
      return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token signing key is not configured", c.get("requestId")), 500);
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 900;
    const jti = id("tok");
    const applicationId = c.get("currentApplicationId");
    const token = await sign({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: body.subjectId,
      azp: applicationId,
      principal_type: "user",
      scope: requested.join(" "),
      iat,
      exp,
      jti,
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");

    return c.json(ok({ accessToken: token, tokenType: "Bearer", expiresIn: 900, scope: requested.join(" ") }));
  });

  app.notFound((c) => c.json(fail("NOT_FOUND", "Route not found", c.get("requestId")), 404));
  app.onError((error, c) => {
    console.error("Unhandled Identity API error", { requestId: c.get("requestId"), error });
    return c.json(fail("INTERNAL_ERROR", "Internal server error", c.get("requestId")), 500);
  });
  return app;
}
