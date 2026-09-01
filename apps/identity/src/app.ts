import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import { AvatarError, bestEffortDeleteUserAvatar, parseAvatarFile, storeUserAvatar } from "./avatar";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  IDENTITY_CONTRACT_VERSION,
  hashApplicationSecret,
  newApplicationSecret,
  registerApplicationAdminRoutes,
  validApplicationTokenTtl,
} from "./application-admin";
import { registerAgentAuthenticationRoutes } from "./agent-auth";
import { registerPlatformAdminRoutes } from "./platform-admin";
import { registerServiceAuthenticationRoutes } from "./service-auth";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type UserBody = { displayName?: string };
type ApplicationBody = {
  id?: string;
  name?: string;
  clientType?: string;
  allowedScopes?: string[];
  trustedBackend?: boolean;
  accessTokenTtlSeconds?: number;
};
type TokenBody = { subjectId?: string; scopes?: string[] };
type UserRow = {
  id: string;
  display_name: string;
  avatar_key: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const TOKEN_ISSUER = "lifespace-identity";
const TOKEN_AUDIENCES = ["lifespace-core", "lifespace-identity"] as const;

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

function avatarUrl(requestUrl: string, userId: string, key: string | null): string | null {
  if (!key) return null;
  return new URL(`/assets/users/${encodeURIComponent(userId)}/avatar`, requestUrl).toString();
}

function userDto(requestUrl: string, row: UserRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: avatarUrl(requestUrl, row.id, row.avatar_key),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 50) {
    throw new AvatarError("INVALID_AVATAR", "displayName must contain 1-50 characters", 400);
  }
  return value.trim();
}

function authenticateUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return c.json(fail("UNAUTHORIZED", "Bearer authentication is required", c.get("requestId")), 401);
    }
    if (!c.env.TOKEN_PUBLIC_KEY) {
      return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token verification key is not configured", c.get("requestId")), 500);
    }
    let payload: Awaited<ReturnType<typeof verify>>;
    try {
      payload = await verify(authorization.slice(7).trim(), c.env.TOKEN_PUBLIC_KEY, "RS256");
    } catch {
      return c.json(fail("UNAUTHORIZED", "Bearer token is invalid", c.get("requestId")), 401);
    }
    if (payload.iss !== TOKEN_ISSUER || !audienceIncludes(payload.aud, "lifespace-identity")) {
      return c.json(fail("UNAUTHORIZED", "Bearer token issuer or audience is invalid", c.get("requestId")), 401);
    }
    if (payload.principal_type !== "user" || typeof payload.sub !== "string" || typeof payload.azp !== "string" || typeof payload.jti !== "string") {
      return c.json(fail("UNAUTHORIZED", "Bearer token principal is invalid", c.get("requestId")), 401);
    }
    const user = await c.env.DB.prepare("SELECT status FROM users WHERE id=?").bind(payload.sub).first<{ status: string }>();
    if (!user || user.status !== "active") {
      return c.json(fail("FORBIDDEN", "User is not active", c.get("requestId")), 403);
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
    c.set("principal", { id: payload.sub, clientId: payload.azp, scopes, tokenId: payload.jti });
    await next();
  };
}

function requireUserScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("principal").scopes.includes(scope)) {
      return c.json(fail("FORBIDDEN", `Scope ${scope} is required`, c.get("requestId")), 403);
    }
    await next();
  };
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
    const secretHash = await hashApplicationSecret(secret);
    const credential = await c.env.DB.prepare(`
      SELECT c.application_id applicationId,
             a.allowed_scopes allowedScopes,
             a.access_token_ttl_seconds accessTokenTtlSeconds
      FROM application_credentials c
      JOIN applications a ON a.id = c.application_id
      WHERE c.secret_hash = ?
        AND c.status = 'active'
        AND c.revoked_at IS NULL
        AND a.status = 'active'
        AND a.trusted_backend = 1
    `).bind(secretHash).first<{ applicationId: string; allowedScopes: string; accessTokenTtlSeconds: number }>();
    if (!credential) {
      return c.json(fail("UNAUTHORIZED", "Trusted application authentication is required", c.get("requestId")), 401);
    }
    c.set("currentApplicationId", credential.applicationId);
    c.set("currentApplicationScopes", JSON.parse(credential.allowedScopes) as string[]);
    c.set("currentApplicationTokenTtlSeconds", credential.accessTokenTtlSeconds);
    await next();
  });

  app.use("/api/v1/me", authenticateUser());
  app.use("/api/v1/me/*", authenticateUser());

  app.get("/health", (c) => c.json(ok({ status: "ok" })));

  app.get("/api/v1/status", async (c) => {
    const row = await c.env.DB.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
    if (!row) throw new Error("schema version metadata is missing");
    return c.json(ok({
      status: "ok",
      service: "identity",
      environment: c.env.ENVIRONMENT ?? "local",
      database: "available",
      schemaVersion: row.value,
      contractVersion: IDENTITY_CONTRACT_VERSION,
    }));
  });

  app.get("/assets/users/:userId/avatar", async (c) => {
    const userId = c.req.param("userId");
    const row = await c.env.DB.prepare("SELECT avatar_key avatarKey FROM users WHERE id=? AND status='active'")
      .bind(userId).first<{ avatarKey: string | null }>();
    if (!row?.avatarKey || !row.avatarKey.startsWith(`avatars/users/${userId}/`)) {
      return c.json(fail("AVATAR_NOT_FOUND", "Avatar not found", c.get("requestId")), 404);
    }
    const object = await c.env.ASSETS.get(row.avatarKey);
    if (!object) return c.json(fail("AVATAR_NOT_FOUND", "Avatar not found", c.get("requestId")), 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=300, must-revalidate");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  });

  app.get("/api/v1/me", requireUserScope("profile:read"), async (c) => {
    const principal = c.get("principal");
    const row = await c.env.DB.prepare("SELECT id,display_name,avatar_key,status,created_at,updated_at FROM users WHERE id=?")
      .bind(principal.id).first<UserRow>();
    if (!row) return c.json(fail("USER_NOT_FOUND", "User not found", c.get("requestId")), 404);
    return c.json(ok(userDto(c.req.url, row)));
  });

  app.patch("/api/v1/me", requireUserScope("profile:write"), async (c) => {
    const input = (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "displayName")) {
      return c.json(fail("INVALID_REQUEST", "Request must contain only displayName", c.get("requestId")), 400);
    }
    let name: string;
    try {
      name = displayName(input.displayName);
    } catch {
      return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-50 characters", c.get("requestId")), 422);
    }
    const principal = c.get("principal");
    const updatedAt = new Date().toISOString();
    const result = await c.env.DB.prepare("UPDATE users SET display_name=?,updated_at=? WHERE id=? AND status='active'")
      .bind(name, updatedAt, principal.id).run();
    if (!result.meta.changes) return c.json(fail("USER_NOT_FOUND", "User not found", c.get("requestId")), 404);
    const row = await c.env.DB.prepare("SELECT id,display_name,avatar_key,status,created_at,updated_at FROM users WHERE id=?")
      .bind(principal.id).first<UserRow>();
    if (!row) throw new Error("User profile missing after update");
    return c.json(ok(userDto(c.req.url, row)));
  });

  app.put("/api/v1/me/avatar", requireUserScope("profile:write"), async (c) => {
    const principal = c.get("principal");
    const previous = await c.env.DB.prepare("SELECT avatar_key avatarKey FROM users WHERE id=? AND status='active'")
      .bind(principal.id).first<{ avatarKey: string | null }>();
    if (!previous) return c.json(fail("USER_NOT_FOUND", "User not found", c.get("requestId")), 404);
    const file = await parseAvatarFile(c.req.raw);
    const newKey = await storeUserAvatar(c.env, principal.id, file);
    try {
      const updatedAt = new Date().toISOString();
      const result = await c.env.DB.prepare("UPDATE users SET avatar_key=?,updated_at=? WHERE id=? AND status='active'")
        .bind(newKey, updatedAt, principal.id).run();
      if (!result.meta.changes) throw new Error("User profile changed while avatar was uploaded");
    } catch (error) {
      await bestEffortDeleteUserAvatar(c.env, principal.id, newKey);
      throw error;
    }
    await bestEffortDeleteUserAvatar(c.env, principal.id, previous.avatarKey);
    return c.json(ok({ avatarUrl: avatarUrl(c.req.url, principal.id, newKey) }));
  });

  app.post("/bootstrap/v1/applications", async (c) => {
    const body = (await c.req.json<ApplicationBody>().catch(() => ({}))) as ApplicationBody;
    if (!body.id || !body.name || !body.clientType || !["web", "mini_program", "service", "device"].includes(body.clientType)) {
      return c.json(fail("VALIDATION_ERROR", "id, name and valid clientType are required", c.get("requestId")), 422);
    }
    const tokenTtlSeconds = body.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    if (!validApplicationTokenTtl(tokenTtlSeconds)) {
      return c.json(fail("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", c.get("requestId")), 422);
    }
    const ts = new Date().toISOString();
    const trustedBackend = body.trustedBackend === true;
    const allowedScopes = body.allowedScopes ?? [];
    const secret = trustedBackend ? newApplicationSecret() : null;

    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`
          INSERT INTO applications(id,name,client_type,allowed_scopes,trusted_backend,access_token_ttl_seconds,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?)
        `).bind(body.id, body.name, body.clientType, JSON.stringify(allowedScopes), trustedBackend ? 1 : 0, tokenTtlSeconds, ts, ts),
        ...(secret ? [c.env.DB.prepare(`
          INSERT INTO application_credentials(id,application_id,secret_hash,secret_suffix,created_at)
          VALUES(?,?,?,?,?)
        `).bind(id("apc"), body.id, await hashApplicationSecret(secret), secret.slice(-8), ts)] : []),
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
      accessTokenTtlSeconds: tokenTtlSeconds,
      ...(secret ? { clientSecret: secret } : {}),
    }), 201);
  });

  registerApplicationAdminRoutes(app);
  registerPlatformAdminRoutes(app);

  app.post("/internal/v1/users", async (c) => {
    const body = (await c.req.json<UserBody>().catch(() => ({}))) as UserBody;
    if (!body.displayName?.trim() || body.displayName.trim().length > 50) {
      return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-50 characters", c.get("requestId")), 422);
    }
    const userId = id("usr");
    const ts = new Date().toISOString();
    await c.env.DB.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES(?,?,?,?)")
      .bind(userId, body.displayName.trim(), ts, ts).run();
    return c.json(ok({ id: userId, displayName: body.displayName.trim() }), 201);
  });

  app.post("/internal/v1/tokens", async (c) => {
    const body = (await c.req.json<TokenBody>().catch(() => ({}))) as TokenBody;
    if (!body.subjectId) {
      return c.json(fail("VALIDATION_ERROR", "subjectId is required", c.get("requestId")), 422);
    }

    const user = await c.env.DB.prepare("SELECT status FROM users WHERE id=?")
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

    const tokenTtlSeconds = c.get("currentApplicationTokenTtlSeconds");
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + tokenTtlSeconds;
    const jti = id("tok");
    const applicationId = c.get("currentApplicationId");
    const token = await sign({
      iss: TOKEN_ISSUER,
      aud: [...TOKEN_AUDIENCES],
      sub: body.subjectId,
      azp: applicationId,
      principal_type: "user",
      scope: requested.join(" "),
      iat,
      exp,
      jti,
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");

    return c.json(ok({ accessToken: token, tokenType: "Bearer", expiresIn: tokenTtlSeconds, scope: requested.join(" ") }));
  });

  registerAgentAuthenticationRoutes(app);
  registerServiceAuthenticationRoutes(app);

  app.notFound((c) => c.json(fail("NOT_FOUND", "Route not found", c.get("requestId")), 404));
  app.onError((error, c) => {
    if (error instanceof AvatarError) {
      return c.json(fail(error.code, error.message, c.get("requestId")), error.status);
    }
    console.error("Unhandled Identity API error", { requestId: c.get("requestId"), error });
    return c.json(fail("INTERNAL_ERROR", "Internal server error", c.get("requestId")), 500);
  });
  return app;
}