import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requirePlatformAdminActor } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type UserRow = {
  id: string;
  display_name: string;
  avatar_key: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type AccessPrincipalRow = {
  id: string;
  issuer: string;
  subject: string;
  user_id: string;
  email_snapshot: string | null;
  status: string;
  linked_at: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });

function avatarUrl(requestUrl: string, userId: string, avatarKey: string | null): string | null {
  return avatarKey ? new URL(`/assets/users/${encodeURIComponent(userId)}/avatar`, requestUrl).toString() : null;
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

function principalDto(row: AccessPrincipalRow) {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    userId: row.user_id,
    emailSnapshot: row.email_snapshot,
    status: row.status,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return 50;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : null;
}

export function registerPlatformInspectorRoutes(app: App): void {
  app.get("/internal/v1/platform-admin/users", async (c) => {
    const actor = await requirePlatformAdminActor(c, "identities:read");
    if (actor instanceof Response) return actor;
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json(fail("VALIDATION_ERROR", "limit must be an integer between 1 and 200", c.get("requestId")), 422);
    const status = c.req.query("status")?.trim();
    if (status && status !== "active" && status !== "disabled") {
      return c.json(fail("VALIDATION_ERROR", "status must be active or disabled", c.get("requestId")), 422);
    }
    const q = c.req.query("q")?.trim().slice(0, 100) ?? "";
    const rows = await c.env.DB.prepare(`
      SELECT id,display_name,avatar_key,status,created_at,updated_at
      FROM users
      WHERE (?='' OR id LIKE '%' || ? || '%' OR display_name LIKE '%' || ? || '%')
        AND (?='' OR status=?)
      ORDER BY created_at DESC,id DESC
      LIMIT ?
    `).bind(q, q, q, status ?? "", status ?? "", limit).all<UserRow>();
    return c.json(ok(rows.results.map((row) => userDto(c.req.url, row))));
  });

  app.get("/internal/v1/platform-admin/users/:userId", async (c) => {
    const actor = await requirePlatformAdminActor(c, "identities:read");
    if (actor instanceof Response) return actor;
    const userId = c.req.param("userId");
    if (!/^usr_[A-Za-z0-9_-]+$/u.test(userId)) return c.json(fail("VALIDATION_ERROR", "userId is invalid", c.get("requestId")), 422);
    const user = await c.env.DB.prepare("SELECT id,display_name,avatar_key,status,created_at,updated_at FROM users WHERE id=?")
      .bind(userId).first<UserRow>();
    if (!user) return c.json(fail("USER_NOT_FOUND", "User not found", c.get("requestId")), 404);
    const principals = await c.env.DB.prepare(`
      SELECT id,issuer,subject,user_id,email_snapshot,status,linked_at,last_seen_at,created_at,updated_at
      FROM access_principals WHERE user_id=? AND subject IS NOT NULL ORDER BY linked_at,id
    `).bind(userId).all<AccessPrincipalRow>();
    return c.json(ok({ ...userDto(c.req.url, user), accessPrincipals: principals.results.map(principalDto) }));
  });
}
