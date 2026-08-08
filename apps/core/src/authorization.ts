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
    const membership = await env.DB.prepare(`SELECT role FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL`).bind(spaceId, principal.id).first<{ role: SpaceRole }>();
    if (membership && rolePermissions[membership.role].includes(permission)) return membership.role;
  }

  const grant = await env.DB.prepare(`SELECT permission FROM data_grants
    WHERE source_space_id=? AND grantee_type=? AND grantee_id=? AND resource_type='space' AND resource_id IS NULL
      AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
    ORDER BY CASE permission WHEN 'manage' THEN 4 WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 1 END DESC LIMIT 1`)
    .bind(spaceId, principal.type, principal.id).first<{ permission: Permission }>();
  if (grant && permissionRank[grant.permission] >= permissionRank[permission]) return "grant";
  throw new ApiError("FORBIDDEN", "Space permission is required", 403);
}
