import type { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const TOKEN_ISSUER = "lifespace-identity";
const TOKEN_AUDIENCES = ["lifespace-core", "lifespace-identity"] as const;
const ACTOR_PROOF_TTL_SECONDS = 300;
const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function parseScopes(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export function registerPlatformAdminActorRoutes(app: App): void {
  app.post("/api/v1/me/platform-admin-actor-token", async (c) => {
    const principal = c.get("principal");
    const state = await c.env.DB.prepare(`SELECT u.status user_status,p.status admin_status,a.status application_status,a.allowed_scopes allowed_scopes
      FROM users u
      LEFT JOIN platform_administrators p ON p.user_id=u.id
      JOIN applications a ON a.id=?
      WHERE u.id=?`).bind(principal.clientId, principal.id).first<{
        user_status: string;
        admin_status: string | null;
        application_status: string;
        allowed_scopes: string;
      }>();
    if (!state || state.user_status !== "active" || state.admin_status !== "active") {
      return c.json(fail("PLATFORM_ADMIN_NOT_ASSIGNED", "User is not an active LifeSpace platform administrator", c.get("requestId")), 403);
    }
    if (state.application_status !== "active" || !parseScopes(state.allowed_scopes).includes("platform:admin")) {
      return c.json(fail("FORBIDDEN", "Calling application is not authorized for platform administration", c.get("requestId")), 403);
    }
    if (!c.env.TOKEN_PRIVATE_KEY) {
      return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token signing key is not configured", c.get("requestId")), 500);
    }

    const iat = Math.floor(Date.now() / 1000);
    const jti = id("pad");
    const token = await sign({
      iss: TOKEN_ISSUER,
      aud: [...TOKEN_AUDIENCES],
      sub: principal.id,
      azp: principal.clientId,
      principal_type: "user",
      scope: "platform:admin",
      purpose: "platform_admin_actor",
      iat,
      exp: iat + ACTOR_PROOF_TTL_SECONDS,
      jti,
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");

    return c.json(ok({
      actorToken: token,
      tokenType: "Bearer",
      expiresIn: ACTOR_PROOF_TTL_SECONDS,
      scope: "platform:admin",
      purpose: "platform_admin_actor",
    }));
  });
}
