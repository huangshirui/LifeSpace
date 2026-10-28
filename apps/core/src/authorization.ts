import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";

export type SpaceRole = "owner" | "admin" | "editor" | "viewer";
export type Permission = "free_busy" | "read" | "write" | "manage";

const rolePermissions: Record<SpaceRole, Permission[]> = {
  owner: ["free_busy", "read", "write", "manage"],
  admin: ["free_busy", "read", "write", "manage"],
  editor: ["free_busy", "read", "write"],
  viewer: ["free_busy", "read"],
};
const permissionRank: Record<Permission, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };

export async function requireSpacePermission(env: Bindings, principal: Principal, spaceId: string, permission: Permission): Promise<SpaceRole | "grant"> {
  if (principal.type === "user") {
    const membership = await env.DB.prepare(`SELECT m.role
      FROM space_memberships m
      JOIN spaces s ON s.id=m.space_id AND s.deleted_at IS NULL
      WHERE m.space_id=? AND m.user_id=? AND m.deleted_at IS NULL`)
      .bind(spaceId, principal.id).first<{ role: SpaceRole }>();
    if (membership && rolePermissions[membership.role].includes(permission)) return membership.role;
  }

  const grant = await env.DB.prepare(`SELECT g.permission
    FROM data_grants g
    JOIN spaces s ON s.id=g.source_space_id AND s.deleted_at IS NULL
    WHERE g.source_space_id=? AND g.grantee_type=? AND g.grantee_id=? AND g.resource_type='space' AND g.resource_id IS NULL
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now'))
    ORDER BY CASE g.permission WHEN 'manage' THEN 4 WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 1 END DESC LIMIT 1`)
    .bind(spaceId, principal.type, principal.id).first<{ permission: Permission }>();
  if (grant && permissionRank[grant.permission] >= permissionRank[permission]) return "grant";
  throw new ApiError("FORBIDDEN", "Space permission is required", 403);
}

/** Kernel Person Directory authority is independent of ordinary-model Grants.
 * Legacy Space Membership/whole-Space Grants continue to work unchanged.
 */
export async function requirePersonDirectoryPermission(
  env: Bindings, principal: Principal, spaceId: string, permission: "read" | "write",
): Promise<SpaceRole | "grant"> {
  try {
    return await requireSpacePermission(env, principal, spaceId, permission);
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.code !== "FORBIDDEN") throw cause;
  }
  const grant = await env.DB.prepare(`SELECT g.permission
    FROM data_grants g
    JOIN spaces s ON s.id=g.source_space_id AND s.deleted_at IS NULL
    WHERE g.source_space_id=? AND g.grantee_type=? AND g.grantee_id=?
      AND g.resource_type='person_directory' AND g.resource_id IS NULL
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now'))
    ORDER BY CASE g.permission WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 0 END DESC LIMIT 1`)
    .bind(spaceId, principal.type, principal.id).first<{ permission: Permission }>();
  if (grant && permissionRank[grant.permission] >= permissionRank[permission]) return "grant";
  throw new ApiError("FORBIDDEN", "Person Directory permission is required", 403);
}
