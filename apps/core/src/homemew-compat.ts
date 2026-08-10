import type { Context, Hono, MiddlewareHandler } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission, type SpaceRole } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type LegacyUserRow = {
  legacy_user_id: string;
  lifespace_user_id: string;
  display_name_snapshot: string;
  source_status: "active" | "disabled";
};
type LegacyFamilyRow = {
  legacy_family_id: string;
  space_id: string;
  legacy_created_by_user_id: string;
  name: string;
  timezone: string;
  version: number;
  created_at: string;
};
type MembershipRow = {
  id: string;
  role: SpaceRole;
  version: number;
  deleted_at: string | null;
};
type PersonRow = { id: string; deleted_at: string | null };
type InviteRow = {
  id: string;
  legacy_invite_id: string;
  space_id: string;
  legacy_family_id: string;
  family_name: string;
  expires_at: string;
  max_uses: number;
  used_count: number;
  status: "active" | "revoked";
  created_by_user_id: string;
  created_at: string;
};

const FAMILY_MEMBER_LIMIT = 8;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export function requireHomeMewCompatibilityClient(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const configured = context.env.HOMEMEW_COMPAT_CLIENT_IDS?.split(",").map((value) => value.trim()).filter(Boolean);
    const allowed = configured?.length ? configured : ["homemew-miniprogram"];
    if (!allowed.includes(context.get("principal").clientId)) {
      throw new ApiError("FORBIDDEN", "Calling application cannot use HomeMew compatibility routes", 403);
    }
    await next();
  };
}

async function requestBody(context: Context<AppEnv>): Promise<Body> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be an object", 400);
  }
  return value as Body;
}

function fields(input: Body, allowed: string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((key) => !supported.has(key))) {
    throw new ApiError("INVALID_REQUEST", `Only ${allowed.join(" and ")} may be supplied`, 400);
  }
}

function requiredText(value: unknown, field: string, maxLength = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError("INVALID_REQUEST", `${field} must contain 1-${maxLength} characters`, 400);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ApiError("INVALID_REQUEST", `${field} must be an integer between 1 and ${max}`, 400);
  }
  return value as number;
}

function ianaTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_REQUEST", "timezone must be an IANA timezone", 400);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new ApiError("INVALID_REQUEST", "timezone must be an IANA timezone", 400);
  }
  return value;
}

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "HomeMew family routes require a user", 403);
}

async function legacyUser(env: Bindings, lifespaceUserId: string): Promise<LegacyUserRow> {
  const row = await env.DB.prepare(`SELECT legacy_user_id,lifespace_user_id,display_name_snapshot,source_status
    FROM legacy_homemew_user_maps WHERE lifespace_user_id=?`).bind(lifespaceUserId).first<LegacyUserRow>();
  if (!row || row.source_status !== "active") throw new ApiError("USER_NOT_FOUND", "Active HomeMew user not found", 404);
  return row;
}

async function family(env: Bindings, legacyFamilyId: string): Promise<LegacyFamilyRow> {
  const row = await env.DB.prepare(`SELECT m.legacy_family_id,m.space_id,m.legacy_created_by_user_id,
      s.name,s.timezone,s.version,s.created_at
    FROM legacy_homemew_family_maps m JOIN spaces s ON s.id=m.space_id
    WHERE m.legacy_family_id=? AND s.kind='family' AND s.deleted_at IS NULL`)
    .bind(legacyFamilyId).first<LegacyFamilyRow>();
  if (!row) throw new ApiError("FAMILY_NOT_FOUND", "Family not found", 404);
  return row;
}

async function memberCount(env: Bindings, spaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) count FROM space_memberships WHERE space_id=? AND deleted_at IS NULL`)
    .bind(spaceId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function membership(env: Bindings, spaceId: string, userId: string, activeOnly = true): Promise<MembershipRow | null> {
  const suffix = activeOnly ? " AND deleted_at IS NULL" : " ORDER BY created_at DESC LIMIT 1";
  return env.DB.prepare(`SELECT id,role,version,deleted_at FROM space_memberships WHERE space_id=? AND user_id=?${suffix}`)
    .bind(spaceId, userId).first<MembershipRow>();
}

function legacyRole(role: SpaceRole): "admin" | "member" {
  if (role === "owner" || role === "admin") return "admin";
  if (role === "editor") return "member";
  throw new ApiError("LEGACY_ROLE_UNSUPPORTED", "Viewer membership is unavailable through HomeMew compatibility routes", 409);
}

function nativeRole(role: unknown): "admin" | "editor" {
  if (role === "admin") return "admin";
  if (role === "member") return "editor";
  throw new ApiError("INVALID_REQUEST", "role is invalid", 400);
}

async function mappedTargetUser(env: Bindings, legacyUserId: string): Promise<LegacyUserRow> {
  const row = await env.DB.prepare(`SELECT legacy_user_id,lifespace_user_id,display_name_snapshot,source_status
    FROM legacy_homemew_user_maps WHERE legacy_user_id=?`).bind(legacyUserId).first<LegacyUserRow>();
  if (!row) throw new ApiError("MEMBER_NOT_FOUND", "Active family member not found", 404);
  return row;
}

async function removeMember(context: Context<AppEnv>, legacyFamilyId: string, legacyTargetUserId: string, selfLeave: boolean): Promise<Response> {
  const principal = context.get("principal");
  requireUser(principal);
  const actor = await legacyUser(context.env, principal.id);
  const mappedFamily = await family(context.env, legacyFamilyId);
  await requireSpacePermission(context.env, principal, mappedFamily.space_id, selfLeave ? "read" : "manage");
  if (!selfLeave && actor.legacy_user_id === legacyTargetUserId) {
    throw new ApiError("CANNOT_REMOVE_SELF", "Use the leave endpoint to leave a family", 409);
  }
  const targetUser = selfLeave ? actor : await mappedTargetUser(context.env, legacyTargetUserId);
  const target = await membership(context.env, mappedFamily.space_id, targetUser.lifespace_user_id);
  if (!target) throw new ApiError("MEMBER_NOT_FOUND", "Active family member not found", 404);
  const removedAt = now();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`UPDATE space_memberships SET deleted_at=?,updated_at=?,version=version+1
      WHERE id=? AND deleted_at IS NULL
      AND (role NOT IN ('owner','admin') OR EXISTS (
        SELECT 1 FROM space_memberships other WHERE other.space_id=? AND other.deleted_at IS NULL
          AND other.role IN ('owner','admin') AND other.id!=?
      ))`).bind(removedAt, removedAt, target.id, mappedFamily.space_id, target.id),
    context.env.DB.prepare(`UPDATE space_people SET deleted_at=?,updated_at=?
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM space_memberships WHERE id=? AND deleted_at=?)`)
      .bind(removedAt, removedAt, mappedFamily.space_id, targetUser.lifespace_user_id, target.id, removedAt),
  ]);
  if (!results[0].meta.changes) {
    throw new ApiError("LAST_ADMIN_CANNOT_BE_REMOVED", "The last administrator cannot leave or be removed", 409);
  }
  return context.body(null, 204);
}

function inviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join("");
  return `LS-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12)}`;
}

async function sha256(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inviteStatus(invite: InviteRow): "active" | "expired" | "exhausted" | "revoked" {
  if (invite.status === "revoked") return "revoked";
  if (Date.now() >= Date.parse(invite.expires_at)) return "expired";
  if (invite.used_count >= invite.max_uses) return "exhausted";
  return "active";
}

function assertInvite(invite: InviteRow): void {
  const status = inviteStatus(invite);
  if (status === "revoked") throw new ApiError("INVITE_REVOKED", "Invite has been revoked", 409);
  if (status === "expired") throw new ApiError("INVITE_EXPIRED", "Invite has expired", 409);
  if (status === "exhausted") throw new ApiError("INVITE_EXHAUSTED", "Invite is exhausted", 409);
}

async function findInvite(env: Bindings, code: string): Promise<InviteRow> {
  const row = await env.DB.prepare(`SELECT i.id,im.legacy_invite_id,i.space_id,fm.legacy_family_id,s.name family_name,i.expires_at,
      i.max_uses,i.used_count,i.status,i.created_by_user_id,i.created_at
    FROM space_invites i JOIN spaces s ON s.id=i.space_id
    JOIN legacy_homemew_family_maps fm ON fm.space_id=s.id
    JOIN legacy_homemew_invite_maps im ON im.invite_id=i.id AND im.legacy_family_id=fm.legacy_family_id
    WHERE i.token_hash=? AND s.kind='family' AND s.deleted_at IS NULL`)
    .bind(await sha256(code)).first<InviteRow>();
  if (!row) throw new ApiError("INVITE_NOT_FOUND", "Invite not found", 404);
  return row;
}

export function registerHomeMewCompatibilityRoutes(app: App): void {
  app.get("/api/v1/me/families", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const rows = await c.env.DB.prepare(`SELECT fm.legacy_family_id id,s.name,s.timezone,m.role,
        (SELECT COUNT(*) FROM space_memberships active WHERE active.space_id=s.id AND active.deleted_at IS NULL) memberCount
      FROM space_memberships m JOIN spaces s ON s.id=m.space_id
      JOIN legacy_homemew_family_maps fm ON fm.space_id=s.id
      WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY m.created_at`)
      .bind(principal.id).all<{ id: string; name: string; timezone: string; role: SpaceRole; memberCount: number }>();
    return c.json(success({ items: rows.results.map((row) => ({
      id: row.id, name: row.name, avatarUrl: null, timezone: row.timezone, role: legacyRole(row.role), memberCount: row.memberCount,
    })) }));
  });

  app.post("/api/v1/families", requireScope("spaces:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const actor = await legacyUser(c.env, principal.id);
    const input = await requestBody(c);
    fields(input, ["name", "timezone"]);
    const name = requiredText(input.name, "name");
    const zone = input.timezone === undefined ? "Asia/Shanghai" : ianaTimezone(input.timezone);
    const count = await c.env.DB.prepare(`SELECT COUNT(*) count FROM legacy_homemew_family_maps fm
      JOIN spaces s ON s.id=fm.space_id WHERE fm.legacy_created_by_user_id=? AND s.deleted_at IS NULL`)
      .bind(actor.legacy_user_id).first<{ count: number }>();
    if ((count?.count ?? 0) >= 3) throw new ApiError("FAMILY_CREATE_LIMIT_REACHED", "Active family creation limit reached", 409);
    const legacyFamilyId = createId("fam");
    const spaceId = createId("spc");
    const membershipId = createId("mem");
    const legacyMembershipId = createId("fmem");
    const personId = createId("per");
    const createdAt = now();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO spaces(id,kind,name,timezone,created_by_user_id,created_at,updated_at)
          VALUES(?,'family',?,?,?,?,?)`).bind(spaceId, name, zone, principal.id, createdAt, createdAt),
        c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
          VALUES(?,?,?,'owner',?,?)`).bind(membershipId, spaceId, principal.id, createdAt, createdAt),
        c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
          VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, principal.id, actor.display_name_snapshot, createdAt, createdAt),
        c.env.DB.prepare(`INSERT INTO legacy_homemew_family_maps(legacy_family_id,space_id,legacy_created_by_user_id,migrated_at)
          VALUES(?,?,?,?)`).bind(legacyFamilyId, spaceId, actor.legacy_user_id, createdAt),
        c.env.DB.prepare(`INSERT INTO legacy_homemew_membership_maps(legacy_membership_id,membership_id,person_id,legacy_family_id,legacy_user_id,migrated_at)
          VALUES(?,?,?,?,?,?)`).bind(legacyMembershipId, membershipId, personId, legacyFamilyId, actor.legacy_user_id, createdAt),
      ]);
    } catch (error) {
      const currentCount = await c.env.DB.prepare(`SELECT COUNT(*) count FROM legacy_homemew_family_maps fm
        JOIN spaces s ON s.id=fm.space_id WHERE fm.legacy_created_by_user_id=? AND s.deleted_at IS NULL`)
        .bind(actor.legacy_user_id).first<{ count: number }>();
      if ((currentCount?.count ?? 0) >= 3) {
        throw new ApiError("FAMILY_CREATE_LIMIT_REACHED", "Active family creation limit reached", 409);
      }
      throw error;
    }
    return c.json(success({
      id: legacyFamilyId, name, avatarUrl: null, timezone: zone, role: "admin", memberCount: 1, createdAt,
    }), 201);
  });

  app.get("/api/v1/families/:familyId", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    const role = await requireSpacePermission(c.env, principal, mappedFamily.space_id, "read");
    if (role === "grant") throw new ApiError("FORBIDDEN", "Active family membership is required", 403);
    return c.json(success({
      id: mappedFamily.legacy_family_id,
      name: mappedFamily.name,
      avatarUrl: null,
      timezone: mappedFamily.timezone,
      status: "active",
      createdBy: mappedFamily.legacy_created_by_user_id,
      currentUserRole: legacyRole(role),
      memberCount: await memberCount(c.env, mappedFamily.space_id),
      createdAt: mappedFamily.created_at,
    }));
  });

  app.patch("/api/v1/families/:familyId", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    await requireSpacePermission(c.env, principal, mappedFamily.space_id, "manage");
    const input = await requestBody(c);
    fields(input, ["name", "timezone"]);
    if (input.name === undefined && input.timezone === undefined) throw new ApiError("INVALID_REQUEST", "Only name and timezone may be supplied", 400);
    const name = input.name === undefined ? mappedFamily.name : requiredText(input.name, "name");
    const zone = input.timezone === undefined ? mappedFamily.timezone : ianaTimezone(input.timezone);
    await c.env.DB.prepare(`UPDATE spaces SET name=?,timezone=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL`)
      .bind(name, zone, now(), mappedFamily.space_id).run();
    return c.json(success({ id: mappedFamily.legacy_family_id, name, avatarUrl: null, timezone: zone, status: "active" }));
  });

  app.get("/api/v1/families/:familyId/members", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    const access = await requireSpacePermission(c.env, principal, mappedFamily.space_id, "read");
    if (access === "grant") throw new ApiError("FORBIDDEN", "Active family membership is required", 403);
    const rows = await c.env.DB.prepare(`SELECT u.legacy_user_id userId,p.display_name displayName,m.role,m.created_at joinedAt
      FROM space_memberships m JOIN space_people p ON p.space_id=m.space_id AND p.linked_user_id=m.user_id AND p.deleted_at IS NULL
      JOIN legacy_homemew_user_maps u ON u.lifespace_user_id=m.user_id
      WHERE m.space_id=? AND m.deleted_at IS NULL ORDER BY m.created_at`).bind(mappedFamily.space_id)
      .all<{ userId: string; displayName: string; role: SpaceRole; joinedAt: string }>();
    return c.json(success({ items: rows.results.map((row) => ({
      userId: row.userId, displayName: row.displayName, avatarUrl: null, role: legacyRole(row.role), joinedAt: row.joinedAt,
    })) }));
  });

  app.patch("/api/v1/families/:familyId/members/:userId", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    await requireSpacePermission(c.env, principal, mappedFamily.space_id, "manage");
    const targetUser = await mappedTargetUser(c.env, c.req.param("userId"));
    const target = await membership(c.env, mappedFamily.space_id, targetUser.lifespace_user_id);
    if (!target) throw new ApiError("MEMBER_NOT_FOUND", "Active family member not found", 404);
    if (target.role === "owner") throw new ApiError("OWNER_ROLE_IMMUTABLE", "The LifeSpace owner role cannot be changed", 409);
    const input = await requestBody(c);
    fields(input, ["role"]);
    const role = nativeRole(input.role);
    const result = await c.env.DB.prepare(`UPDATE space_memberships SET role=?,updated_at=?,version=version+1
      WHERE id=? AND deleted_at IS NULL
      AND (role!='admin' OR ?='admin' OR EXISTS (
        SELECT 1 FROM space_memberships other WHERE other.space_id=? AND other.deleted_at IS NULL
          AND other.role IN ('owner','admin') AND other.id!=?
      ))`).bind(role, now(), target.id, role, mappedFamily.space_id, target.id).run();
    if (!result.meta.changes) throw new ApiError("LAST_ADMIN_CANNOT_BE_REMOVED", "The last administrator cannot be demoted", 409);
    return c.json(success({ userId: targetUser.legacy_user_id, role: legacyRole(role) }));
  });

  app.delete("/api/v1/families/:familyId/members/:userId", requireScope("spaces:manage"), (c) =>
    removeMember(c, c.req.param("familyId"), c.req.param("userId"), false));
  app.post("/api/v1/families/:familyId/leave", requireScope("spaces:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const actor = await legacyUser(c.env, principal.id);
    return removeMember(c, c.req.param("familyId"), actor.legacy_user_id, true);
  });

  app.post("/api/v1/families/:familyId/invites", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    await requireSpacePermission(c.env, principal, mappedFamily.space_id, "manage");
    const input = await requestBody(c);
    fields(input, ["expiresInMinutes", "maxUses"]);
    const expiresInMinutes = positiveInteger(input.expiresInMinutes, "expiresInMinutes", 1440, 43_200);
    const maxUses = positiveInteger(input.maxUses, "maxUses", 8, 8);
    const code = inviteToken();
    const inviteId = createId("inv");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO space_invites(id,space_id,token_hash,token_prefix,role,expires_at,max_uses,created_by_user_id,created_at,updated_at)
        VALUES(?,?,?,?,'editor',?,?,?,?,?)`).bind(inviteId, mappedFamily.space_id, await sha256(code), code.slice(0, 7), expiresAt, maxUses, principal.id, createdAt, createdAt),
      c.env.DB.prepare(`INSERT INTO legacy_homemew_invite_maps(legacy_invite_id,invite_id,legacy_family_id,migrated_at)
        VALUES(?,?,?,?)`).bind(inviteId, inviteId, mappedFamily.legacy_family_id, createdAt),
    ]);
    return c.json(success({ id: inviteId, code, joinPath: `pages/family/join?code=${code}`, expiresAt, maxUses, usedCount: 0 }), 201);
  });

  app.get("/api/v1/families/:familyId/invites", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    await requireSpacePermission(c.env, principal, mappedFamily.space_id, "manage");
    const rows = await c.env.DB.prepare(`SELECT i.id,im.legacy_invite_id,i.space_id,? legacy_family_id,s.name family_name,i.expires_at,i.max_uses,
        i.used_count,i.status,i.created_by_user_id,i.created_at
      FROM space_invites i JOIN spaces s ON s.id=i.space_id
      JOIN legacy_homemew_invite_maps im ON im.invite_id=i.id AND im.legacy_family_id=?
      WHERE i.space_id=? ORDER BY i.created_at DESC`)
      .bind(mappedFamily.legacy_family_id, mappedFamily.legacy_family_id, mappedFamily.space_id).all<InviteRow>();
    const creators = await c.env.DB.prepare(`SELECT legacy_user_id,lifespace_user_id FROM legacy_homemew_user_maps`).all<{ legacy_user_id: string; lifespace_user_id: string }>();
    const userIds = new Map(creators.results.map((row) => [row.lifespace_user_id, row.legacy_user_id]));
    return c.json(success({ items: rows.results.map((invite) => ({
      id: invite.legacy_invite_id,
      status: inviteStatus(invite),
      expiresAt: invite.expires_at,
      maxUses: invite.max_uses,
      usedCount: invite.used_count,
      createdBy: userIds.get(invite.created_by_user_id) ?? invite.created_by_user_id,
      createdAt: invite.created_at,
    })) }));
  });

  app.post("/api/v1/families/:familyId/invites/:inviteId/revoke", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const mappedFamily = await family(c.env, c.req.param("familyId"));
    await requireSpacePermission(c.env, principal, mappedFamily.space_id, "manage");
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE space_invites SET status='revoked',revoked_by_user_id=?,revoked_at=?,updated_at=?
      WHERE id=(SELECT invite_id FROM legacy_homemew_invite_maps WHERE legacy_invite_id=? AND legacy_family_id=?) AND space_id=?`)
      .bind(principal.id, revokedAt, revokedAt, c.req.param("inviteId"), mappedFamily.legacy_family_id, mappedFamily.space_id).run();
    if (!result.meta.changes) throw new ApiError("INVITE_NOT_FOUND", "Invite not found", 404);
    return c.body(null, 204);
  });

  app.get("/api/v1/family-invites/:code", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    await legacyUser(c.env, principal.id);
    const invite = await findInvite(c.env, c.req.param("code"));
    const count = await memberCount(c.env, invite.space_id);
    return c.json(success({
      family: { id: invite.legacy_family_id, name: invite.family_name, avatarUrl: null, memberCount: count },
      expiresAt: invite.expires_at,
      canJoin: inviteStatus(invite) === "active" && count < FAMILY_MEMBER_LIMIT,
    }));
  });

  app.post("/api/v1/family-invites/:code/join", requireScope("spaces:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const actor = await legacyUser(c.env, principal.id);
    const invite = await findInvite(c.env, c.req.param("code"));
    assertInvite(invite);
    if (await membership(c.env, invite.space_id, principal.id)) throw new ApiError("ALREADY_FAMILY_MEMBER", "User is already a family member", 409);
    if (await memberCount(c.env, invite.space_id) >= FAMILY_MEMBER_LIMIT) {
      throw new ApiError("FAMILY_MEMBER_LIMIT_REACHED", "Family member limit reached", 409);
    }
    const previousMembership = await membership(c.env, invite.space_id, principal.id, false);
    const previousPerson = await c.env.DB.prepare(`SELECT id,deleted_at FROM space_people WHERE space_id=? AND linked_user_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(invite.space_id, principal.id).first<PersonRow>();
    const redemptionId = createId("ird");
    const membershipId = previousMembership?.id ?? createId("mem");
    const personId = previousPerson?.id ?? createId("per");
    const legacyMembershipId = createId("fmem");
    const joinedAt = now();
    const redemption = c.env.DB.prepare(`INSERT INTO space_invite_redemptions(id,invite_id,space_id,user_id,redeemed_at)
      SELECT ?,i.id,i.space_id,?,? FROM space_invites i JOIN spaces s ON s.id=i.space_id
      WHERE i.id=? AND i.status='active' AND julianday(i.expires_at)>julianday('now') AND i.used_count<i.max_uses
      AND s.deleted_at IS NULL
      AND (SELECT COUNT(*) FROM space_memberships WHERE space_id=i.space_id AND deleted_at IS NULL)<${FAMILY_MEMBER_LIMIT}
      AND NOT EXISTS (SELECT 1 FROM space_memberships WHERE space_id=i.space_id AND user_id=? AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM space_invite_redemptions WHERE invite_id=i.id AND user_id=?)`)
      .bind(redemptionId, principal.id, joinedAt, invite.id, principal.id, principal.id);
    const activateMembership = previousMembership
      ? c.env.DB.prepare(`UPDATE space_memberships SET role='editor',deleted_at=NULL,updated_at=?,version=version+1
          WHERE id=? AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(joinedAt, membershipId, redemptionId)
      : c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
          SELECT ?,?,?,'editor',?,? WHERE EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(membershipId, invite.space_id, principal.id, joinedAt, joinedAt, redemptionId);
    const activatePerson = previousPerson
      ? c.env.DB.prepare(`UPDATE space_people SET display_name=?,deleted_at=NULL,updated_at=?
          WHERE id=? AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(actor.display_name_snapshot, joinedAt, personId, redemptionId)
      : c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(personId, invite.space_id, principal.id, actor.display_name_snapshot, joinedAt, joinedAt, redemptionId);
    const mapMembership = c.env.DB.prepare(`INSERT OR IGNORE INTO legacy_homemew_membership_maps(
        legacy_membership_id,membership_id,person_id,legacy_family_id,legacy_user_id,migrated_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
      .bind(legacyMembershipId, membershipId, personId, invite.legacy_family_id, actor.legacy_user_id, joinedAt, redemptionId);
    const results = await c.env.DB.batch([redemption, activateMembership, activatePerson, mapMembership]);
    if (!results[0].meta.changes) {
      const current = await findInvite(c.env, c.req.param("code"));
      assertInvite(current);
      if (await memberCount(c.env, current.space_id) >= FAMILY_MEMBER_LIMIT) {
        throw new ApiError("FAMILY_MEMBER_LIMIT_REACHED", "Family member limit reached", 409);
      }
      throw new ApiError("ALREADY_FAMILY_MEMBER", "User is already a family member", 409);
    }
    return c.json(success({ familyId: invite.legacy_family_id, familyName: invite.family_name, role: "member", joinedAt }));
  });
}
