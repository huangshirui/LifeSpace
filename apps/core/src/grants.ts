import { Hono } from "hono";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireScope } from "./auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Permission = "free_busy" | "read" | "write" | "manage";
type GrantRow = {
  id: string;
  source_space_id: string;
  grantee_type: "user" | "space" | "service" | "device";
  grantee_id: string;
  resource_type: string;
  resource_id: string | null;
  permission: Permission;
  created_by_user_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

const now = () => new Date().toISOString();

function requireUser(principal: { type: string }): void {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "A user principal is required to manage Data Grants", 403);
}

function dto(row: GrantRow) {
  return {
    id: row.id,
    sourceSpaceId: row.source_space_id,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    permission: row.permission,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function parseExpiry(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw new ApiError("VALIDATION_ERROR", "expiresAt must be a future RFC 3339 UTC instant or null", 422);
  }
  return value;
}

export function registerGrantRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/grants", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const rows = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE source_space_id=? AND resource_type='space' AND resource_id IS NULL
      ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY created_at DESC`).bind(spaceId).all<GrantRow>();
    return c.json(success(rows.results.map(dto)));
  });

  app.patch("/api/v1/spaces/:spaceId/grants/:grantId", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const current = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=? AND source_space_id=? AND revoked_at IS NULL`).bind(c.req.param("grantId"), spaceId).first<GrantRow>();
    if (!current) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("INVALID_REQUEST", "JSON body is required", 400);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["permission", "expiresAt"].includes(key))) throw new ApiError("INVALID_REQUEST", "Only permission and expiresAt may be updated", 400);
    const permission = body.permission === undefined ? current.permission : body.permission;
    if (!['free_busy', 'read', 'write', 'manage'].includes(permission as string)) throw new ApiError("VALIDATION_ERROR", "permission is invalid", 422);
    const expiresAt = body.expiresAt === undefined ? current.expires_at : parseExpiry(body.expiresAt);
    await c.env.DB.prepare("UPDATE data_grants SET permission=?,expires_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL")
      .bind(permission, expiresAt, current.id, spaceId).run();
    const updated = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=?`).bind(current.id).first<GrantRow>();
    if (!updated) throw new Error("Data Grant missing after update");
    return c.json(success(dto(updated)));
  });

  app.delete("/api/v1/spaces/:spaceId/grants/:grantId", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const result = await c.env.DB.prepare("UPDATE data_grants SET revoked_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL")
      .bind(now(), c.req.param("grantId"), spaceId).run();
    if (!result.meta.changes) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    return c.body(null, 204);
  });
}
