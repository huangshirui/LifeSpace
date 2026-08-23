import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const now = () => new Date().toISOString();

export function registerPlatformAdminAssignmentRoutes(app: App): void {
  app.get("/bootstrap/v1/platform-administrators", async (c) => {
    const rows = await c.env.DB.prepare(`SELECT p.user_id userId,p.status,p.assigned_at assignedAt,p.revoked_at revokedAt,
      u.display_name displayName,u.status userStatus
      FROM platform_administrators p JOIN users u ON u.id=p.user_id
      ORDER BY p.assigned_at,p.user_id`).all();
    return c.json(ok(rows.results));
  });

  app.put("/bootstrap/v1/platform-administrators/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (!/^usr_[A-Za-z0-9_-]+$/u.test(userId)) return c.json(fail("VALIDATION_ERROR", "userId is invalid", c.get("requestId")), 422);
    const user = await c.env.DB.prepare("SELECT status FROM users WHERE id=?").bind(userId).first<{ status: string }>();
    if (!user) return c.json(fail("USER_NOT_FOUND", "User not found", c.get("requestId")), 404);
    if (user.status !== "active") return c.json(fail("FORBIDDEN", "Platform administrator must be an active user", c.get("requestId")), 403);
    const assignedAt = now();
    await c.env.DB.prepare(`INSERT INTO platform_administrators(user_id,status,assigned_at,revoked_at)
      VALUES(?,'active',?,NULL)
      ON CONFLICT(user_id) DO UPDATE SET status='active',assigned_at=excluded.assigned_at,revoked_at=NULL`)
      .bind(userId, assignedAt).run();
    return c.json(ok({ userId, status: "active", assignedAt }));
  });

  app.delete("/bootstrap/v1/platform-administrators/:userId", async (c) => {
    const userId = c.req.param("userId");
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE platform_administrators SET status='revoked',revoked_at=?
      WHERE user_id=? AND status='active'`).bind(revokedAt, userId).run();
    if (!result.meta.changes) return c.json(fail("PLATFORM_ADMIN_NOT_FOUND", "Active platform administrator assignment not found", c.get("requestId")), 404);
    return c.body(null, 204);
  });
}
