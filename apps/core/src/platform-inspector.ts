import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type SpaceRow = {
  id: string;
  name: string;
  timezone: string;
  avatar_key: string | null;
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  member_count?: number;
  grant_count?: number;
  record_count?: number;
};

type MemberRow = {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "editor" | "viewer";
  version: number;
  created_at: string;
  person_id: string;
  display_name: string;
};

type GrantRow = {
  id: string;
  grantee_type: "user" | "space" | "service" | "device";
  grantee_id: string;
  resource_type: string;
  resource_id: string | null;
  permission: "free_busy" | "read" | "write" | "manage";
  created_by_user_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type RecordCountRow = { model_key: string; count: number };

function avatarUrl(requestUrl: string, spaceId: string, avatarKey: string | null): string | null {
  return avatarKey ? new URL(`/assets/spaces/${encodeURIComponent(spaceId)}/avatar`, requestUrl).toString() : null;
}

function spaceDto(requestUrl: string, row: SpaceRow) {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    avatarUrl: avatarUrl(requestUrl, row.id, row.avatar_key),
    version: row.version,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.member_count === undefined ? {} : { memberCount: row.member_count }),
    ...(row.grant_count === undefined ? {} : { grantCount: row.grant_count }),
    ...(row.record_count === undefined ? {} : { recordCount: row.record_count }),
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new ApiError("VALIDATION_ERROR", "limit must be an integer between 1 and 200", 422);
  return parsed;
}

export function registerPlatformInspectorRoutes(app: App): void {
  app.get("/api/v1/platform-admin/spaces", async (c) => {
    await requirePlatformAdminContext(c, "spaces:inspect");
    const limit = parseLimit(c.req.query("limit"));
    const q = c.req.query("q")?.trim().slice(0, 100) ?? "";
    const rows = await c.env.DB.prepare(`
      SELECT s.id,s.name,s.timezone,s.avatar_key,s.version,s.created_by_user_id,s.created_at,s.updated_at,
        (SELECT COUNT(*) FROM space_memberships m WHERE m.space_id=s.id AND m.deleted_at IS NULL) member_count,
        (SELECT COUNT(*) FROM data_grants g WHERE g.source_space_id=s.id AND g.revoked_at IS NULL) grant_count,
        (SELECT COUNT(*) FROM resource_records r WHERE r.space_id=s.id AND r.deleted_at IS NULL) record_count
      FROM spaces s
      WHERE s.deleted_at IS NULL
        AND (?='' OR s.id LIKE '%' || ? || '%' OR s.name LIKE '%' || ? || '%')
      ORDER BY s.created_at DESC,s.id DESC
      LIMIT ?
    `).bind(q, q, q, limit).all<SpaceRow>();
    return c.json(success(rows.results.map((row) => spaceDto(c.req.url, row))));
  });

  app.get("/api/v1/platform-admin/spaces/:spaceId", async (c) => {
    await requirePlatformAdminContext(c, "spaces:inspect");
    const spaceId = c.req.param("spaceId");
    if (!/^spc_[A-Za-z0-9_-]+$/u.test(spaceId)) throw new ApiError("VALIDATION_ERROR", "spaceId is invalid", 422);
    const space = await c.env.DB.prepare(`SELECT id,name,timezone,avatar_key,version,created_by_user_id,created_at,updated_at
      FROM spaces WHERE id=? AND deleted_at IS NULL`).bind(spaceId).first<SpaceRow>();
    if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

    const [members, grants, counts] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT m.id,m.user_id,m.role,m.version,m.created_at,p.id person_id,p.display_name
        FROM space_memberships m
        JOIN space_people p ON p.space_id=m.space_id AND p.linked_user_id=m.user_id AND p.deleted_at IS NULL
        WHERE m.space_id=? AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`).bind(spaceId),
      c.env.DB.prepare(`SELECT id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
        FROM data_grants WHERE source_space_id=? ORDER BY created_at,id`).bind(spaceId),
      c.env.DB.prepare(`SELECT model_key,COUNT(*) count FROM resource_records
        WHERE space_id=? AND deleted_at IS NULL GROUP BY model_key ORDER BY model_key`).bind(spaceId),
    ]);

    return c.json(success({
      ...spaceDto(c.req.url, space),
      members: (members.results as MemberRow[]).map((row) => ({
        id: row.id,
        userId: row.user_id,
        personId: row.person_id,
        displayName: row.display_name,
        role: row.role,
        version: row.version,
        createdAt: row.created_at,
      })),
      grants: (grants.results as GrantRow[]).map((row) => ({
        id: row.id,
        granteeType: row.grantee_type,
        granteeId: row.grantee_id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        permission: row.permission,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
      recordCounts: Object.fromEntries((counts.results as RecordCountRow[]).map((row) => [row.model_key, row.count])),
    }));
  });
}
