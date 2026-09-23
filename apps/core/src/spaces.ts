import type { Context, Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { requireScope } from "./auth";
import { requireSpacePermission, type SpaceRole } from "./authorization";
import { ApiError, success } from "./http";
import { assertIanaTimezone } from "./time-semantics";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type SpaceRow = { id: string; name: string; timezone: string; avatar_key: string | null; version: number };
type MembershipRow = { id: string; space_id: string; user_id: string; role: SpaceRole; version: number; deleted_at: string | null };
type PersonRow = { id: string; deleted_at: string | null };
type InviteRow = {
  id: string;
  space_id: string;
  token_prefix: string;
  role: Exclude<SpaceRole, "owner">;
  expires_at: string;
  max_uses: number;
  used_count: number;
  status: "active" | "revoked";
  created_by_user_id: string;
  created_at: string;
};

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function body(context: Context<AppEnv>): Promise<Body> {
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

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "Only users can manage Space membership", 403);
}

function text(value: unknown, field: string, maxLength = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError("VALIDATION_ERROR", `${field} must contain 1-${maxLength} characters`, 422);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ApiError("VALIDATION_ERROR", `${field} must be an integer between 1 and ${max}`, 422);
  }
  return value as number;
}

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ApiError("VALIDATION_ERROR", "version must be a positive integer", 422);
  }
  return value as number;
}

function timezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("VALIDATION_ERROR", "timezone must be an IANA timezone", 422);
  try {
    return assertIanaTimezone(value);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "timezone must be an IANA timezone", 422);
  }
}

function fields(input: Body, allowed: string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((key) => !supported.has(key))) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported fields", 400);
  }
}

async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {
  const row = await env.DB.prepare("SELECT id,name,timezone,avatar_key,version FROM spaces WHERE id=? AND deleted_at IS NULL")
    .bind(spaceId).first<SpaceRow>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return row;
}

function spaceAvatarUrl(requestUrl: string, spaceId: string, avatarKey: string | null): string | null {
  if (!avatarKey) return null;
  return new URL(`/assets/spaces/${encodeURIComponent(spaceId)}/avatar`, requestUrl).toString();
}

function spaceDto<T extends SpaceRow>(requestUrl: string, row: T) {
  const { avatar_key: avatarKey, ...rest } = row;
  return { ...rest, avatarUrl: spaceAvatarUrl(requestUrl, row.id, avatarKey) };
}

async function findMembership(env: Bindings, spaceId: string, userId: string, activeOnly = true): Promise<MembershipRow | null> {
  const suffix = activeOnly ? " AND deleted_at IS NULL" : " ORDER BY created_at DESC LIMIT 1";
  return env.DB.prepare(`SELECT id,space_id,user_id,role,version,deleted_at FROM space_memberships WHERE space_id=? AND user_id=?${suffix}`)
    .bind(spaceId, userId).first<MembershipRow>();
}

function membershipDto(row: MembershipRow, personId?: string, displayName?: string) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    version: row.version,
    ...(personId ? { personId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

async function memberCount(env: Bindings, spaceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) count FROM space_memberships WHERE space_id=? AND deleted_at IS NULL")
    .bind(spaceId).first<{ count: number }>();
  return row?.count ?? 0;
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
  if (status === "exhausted") throw new ApiError("INVITE_EXHAUSTED", "Invite has no uses remaining", 409);
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

async function findInvite(env: Bindings, token: string): Promise<InviteRow & { space_name: string; timezone: string }> {
  const invite = await env.DB.prepare(`SELECT i.*,s.name space_name,s.timezone
    FROM space_invites i JOIN spaces s ON s.id=i.space_id
    WHERE i.token_hash=? AND s.deleted_at IS NULL`).bind(await sha256(token)).first<InviteRow & { space_name: string; timezone: string }>();
  if (!invite) throw new ApiError("INVITE_NOT_FOUND", "Invite not found", 404);
  return invite;
}

async function removeMembership(context: Context<AppEnv>, targetUserId: string, selfLeave: boolean): Promise<Response> {
  const principal = context.get("principal");
  requireUser(principal);
  const spaceId = context.req.param("spaceId");
  if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
  await requireSpacePermission(context.env, principal, spaceId, selfLeave ? "read" : "manage");
  if (!selfLeave && targetUserId === principal.id) throw new ApiError("CANNOT_REMOVE_SELF", "Use the leave endpoint", 409);
  const target = await findMembership(context.env, spaceId, targetUserId);
  if (!target) throw new ApiError("MEMBER_NOT_FOUND", "Active Space member not found", 404);
  const removedAt = now();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`UPDATE space_memberships SET deleted_at=?,updated_at=?,version=version+1
      WHERE id=? AND deleted_at IS NULL
      AND (role NOT IN ('owner','admin') OR EXISTS (
        SELECT 1 FROM space_memberships other
        WHERE other.space_id=? AND other.deleted_at IS NULL AND other.role IN ('owner','admin') AND other.id!=?
      ))`).bind(removedAt, removedAt, target.id, spaceId, target.id),
    context.env.DB.prepare(`UPDATE space_people SET deleted_at=?,updated_at=?
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM space_memberships WHERE id=? AND deleted_at=?)`)
      .bind(removedAt, removedAt, spaceId, targetUserId, target.id, removedAt),
  ]);
  if (!results[0].meta.changes) throw new ApiError("LAST_SPACE_MANAGER", "A Space must retain an owner or administrator", 409);
  return context.body(null, 204);
}

export function registerSpaceRoutes(app: App): void {
  app.get("/api/v1/me", requireScope("profile:read"), async (c) => c.json(success({ principal: c.get("principal") })));

  app.get("/api/v1/me/spaces", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    const result = principal.type === "user"
      ? await c.env.DB.prepare(`SELECT s.id,s.name,s.timezone,s.avatar_key,m.role,s.version
          FROM spaces s JOIN space_memberships m ON m.space_id=s.id
          WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY m.created_at`)
        .bind(principal.id).all<SpaceRow & { role: SpaceRole }>()
      : { results: [] as (SpaceRow & { role: SpaceRole })[] };
    return c.json(success(result.results.map((row) => spaceDto(c.req.url, row))));
  });

  app.post("/api/v1/spaces", requireScope("spaces:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const input = await body(c);
    fields(input, ["name", "ownerDisplayName", "timezone"]);
    const name = text(input.name, "name");
    const ownerDisplayName = text(input.ownerDisplayName, "ownerDisplayName");
    const zone = input.timezone === undefined ? "UTC" : timezone(input.timezone);
    const spaceId = createId("spc");
    const membershipId = createId("mem");
    const personId = createId("per");
    const createdAt = now();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO spaces(id,name,timezone,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .bind(spaceId, name, zone, principal.id, createdAt, createdAt),
      c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .bind(membershipId, spaceId, principal.id, "owner", createdAt, createdAt),
      c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .bind(personId, spaceId, principal.id, ownerDisplayName, createdAt, createdAt),
    ]);
    return c.json(success({ id: spaceId, name, timezone: zone, avatarUrl: null, role: "owner", ownerPersonId: personId, version: 1 }), 201);
  });

  app.get("/api/v1/spaces/:spaceId", requireScope("spaces:read"), async (c) => {
    const principal = c.get("principal");
    const spaceId = c.req.param("spaceId");
    const access = await requireSpacePermission(c.env, principal, spaceId, "read");
    return c.json(success({ ...spaceDto(c.req.url, await findSpace(c.env, spaceId)), access }));
  });

  app.patch("/api/v1/spaces/:spaceId", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const input = await body(c);
    fields(input, ["name", "timezone", "version"]);
    if (input.name === undefined && input.timezone === undefined) throw new ApiError("INVALID_REQUEST", "At least one Space change is required", 400);
    const expected = version(input.version);
    const previous = await findSpace(c.env, spaceId);
    const name = input.name === undefined ? previous.name : text(input.name, "name");
    const zone = input.timezone === undefined ? previous.timezone : timezone(input.timezone);
    const updated = await c.env.DB.prepare(`UPDATE spaces SET name=?,timezone=?,updated_at=?,version=version+1
      WHERE id=? AND deleted_at IS NULL AND version=?`).bind(name, zone, now(), spaceId, expected).run();
    if (!updated.meta.changes) throw new ApiError("SPACE_VERSION_CONFLICT", "Space version conflict", 409);
    return c.json(success(spaceDto(c.req.url, await findSpace(c.env, spaceId))));
  });

  app.get("/api/v1/spaces/:spaceId/members", requireScope("spaces:read"), async (c) => {
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, c.get("principal"), spaceId, "read");
    const rows = await c.env.DB.prepare(`SELECT m.id,m.user_id userId,m.role,m.version,p.id personId,p.display_name displayName,m.created_at createdAt
      FROM space_memberships m JOIN space_people p ON p.space_id=m.space_id AND p.linked_user_id=m.user_id AND p.deleted_at IS NULL
      WHERE m.space_id=? AND m.deleted_at IS NULL ORDER BY m.created_at`).bind(spaceId).all();
    return c.json(success(rows.results));
  });

  app.post("/api/v1/spaces/:spaceId/members", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const input = await body(c);
    fields(input, ["userId", "role", "displayName"]);
    const userId = text(input.userId, "userId", 200);
    if (!['admin', 'editor', 'viewer'].includes(input.role as string)) throw new ApiError("VALIDATION_ERROR", "role is invalid", 422);
    const role = input.role as Exclude<SpaceRole, "owner">;
    const displayName = text(input.displayName, "displayName");
    if (await findMembership(c.env, spaceId, userId)) throw new ApiError("MEMBER_ALREADY_ACTIVE", "User is already an active Space member", 409);
    const previousMembership = await findMembership(c.env, spaceId, userId, false);
    const previousPerson = await c.env.DB.prepare(`SELECT id,deleted_at FROM space_people WHERE space_id=? AND linked_user_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(spaceId, userId).first<PersonRow>();
    const addedAt = now();
    const membershipId = previousMembership?.id ?? createId("mem");
    const personId = previousPerson?.id ?? createId("per");
    const statements = previousMembership
      ? [c.env.DB.prepare(`UPDATE space_memberships SET role=?,deleted_at=NULL,updated_at=?,version=version+1
          WHERE id=? AND deleted_at IS NOT NULL`)
        .bind(role, addedAt, membershipId)]
      : [c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
            SELECT 1 FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL
          )`)
        .bind(membershipId, spaceId, userId, role, addedAt, addedAt, spaceId, userId)];
    statements.push(previousPerson
      ? c.env.DB.prepare(`UPDATE space_people SET display_name=?,deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM space_memberships WHERE id=? AND deleted_at IS NULL AND updated_at=?)`)
        .bind(displayName, addedAt, personId, membershipId, addedAt)
      : c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM space_memberships WHERE id=? AND deleted_at IS NULL AND updated_at=?)`)
        .bind(personId, spaceId, userId, displayName, addedAt, addedAt, membershipId, addedAt));
    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      if (await findMembership(c.env, spaceId, userId)) {
        throw new ApiError("MEMBER_ALREADY_ACTIVE", "User is already an active Space member", 409);
      }
      throw error;
    }
    const current = await findMembership(c.env, spaceId, userId);
    if (!current) throw new ApiError("MEMBER_ALREADY_ACTIVE", "User is already an active Space member", 409);
    return c.json(success(membershipDto(current, personId, displayName)), 201);
  });

  app.patch("/api/v1/spaces/:spaceId/members/:userId", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const target = await findMembership(c.env, spaceId, c.req.param("userId"));
    if (!target) throw new ApiError("MEMBER_NOT_FOUND", "Active Space member not found", 404);
    if (target.role === "owner") throw new ApiError("OWNER_ROLE_IMMUTABLE", "Owner role cannot be changed", 409);
    const input = await body(c);
    fields(input, ["role", "version"]);
    if (!['admin', 'editor', 'viewer'].includes(input.role as string)) throw new ApiError("VALIDATION_ERROR", "role is invalid", 422);
    const role = input.role as Exclude<SpaceRole, "owner">;
    const expected = version(input.version);
    const updated = await c.env.DB.prepare(`UPDATE space_memberships SET role=?,updated_at=?,version=version+1
      WHERE id=? AND deleted_at IS NULL AND version=?
      AND (role!='admin' OR ?='admin' OR EXISTS (
        SELECT 1 FROM space_memberships other
        WHERE other.space_id=? AND other.deleted_at IS NULL AND other.role IN ('owner','admin') AND other.id!=?
      ))`).bind(role, now(), target.id, expected, role, spaceId, target.id).run();
    if (!updated.meta.changes) {
      const current = await findMembership(c.env, spaceId, target.user_id);
      if (current?.version !== expected) throw new ApiError("MEMBERSHIP_VERSION_CONFLICT", "Membership version conflict", 409);
      throw new ApiError("LAST_SPACE_MANAGER", "A Space must retain an owner or administrator", 409);
    }
    const current = await findMembership(c.env, spaceId, target.user_id);
    if (!current) throw new Error("Active membership is missing after role update");
    return c.json(success(membershipDto(current)));
  });

  app.delete("/api/v1/spaces/:spaceId/members/:userId", requireScope("spaces:manage"), (c) => removeMembership(c, c.req.param("userId"), false));
  app.post("/api/v1/spaces/:spaceId/leave", requireScope("spaces:write"), (c) => removeMembership(c, c.get("principal").id, true));

  app.post("/api/v1/spaces/:spaceId/invites", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    await findSpace(c.env, spaceId);
    const input = await body(c);
    fields(input, ["role", "expiresInMinutes", "maxUses"]);
    const role = input.role === undefined ? "editor" : input.role;
    if (!['admin', 'editor', 'viewer'].includes(role as string)) throw new ApiError("VALIDATION_ERROR", "role is invalid", 422);
    const expiresInMinutes = positiveInteger(input.expiresInMinutes, "expiresInMinutes", 1440, 43_200);
    const maxUses = positiveInteger(input.maxUses, "maxUses", 1, 100);
    const token = inviteToken();
    const inviteId = createId("inv");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
    await c.env.DB.prepare(`INSERT INTO space_invites(id,space_id,token_hash,token_prefix,role,expires_at,max_uses,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(inviteId, spaceId, await sha256(token), token.slice(0, 7), role, expiresAt, maxUses, principal.id, createdAt, createdAt).run();
    return c.json(success({
      id: inviteId,
      token,
      role,
      status: "active",
      expiresAt,
      maxUses,
      usedCount: 0,
      createdByUserId: principal.id,
      createdAt,
    }), 201);
  });

  app.get("/api/v1/spaces/:spaceId/invites", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const rows = await c.env.DB.prepare(`SELECT id,space_id,token_prefix,role,expires_at,max_uses,used_count,status,created_by_user_id,created_at
      FROM space_invites WHERE space_id=? ORDER BY created_at DESC`).bind(spaceId).all<InviteRow>();
    return c.json(success(rows.results.map((invite) => ({
      id: invite.id, tokenPrefix: invite.token_prefix, role: invite.role, status: inviteStatus(invite), expiresAt: invite.expires_at,
      maxUses: invite.max_uses, usedCount: invite.used_count, createdByUserId: invite.created_by_user_id, createdAt: invite.created_at,
    }))));
  });

  app.post("/api/v1/spaces/:spaceId/invites/:inviteId/revoke", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const revokedAt = now();
    const result = await c.env.DB.prepare(`UPDATE space_invites SET status='revoked',revoked_by_user_id=?,revoked_at=?,updated_at=?
      WHERE id=? AND space_id=? AND status='active'`).bind(principal.id, revokedAt, revokedAt, c.req.param("inviteId"), spaceId).run();
    if (!result.meta.changes) throw new ApiError("INVITE_NOT_FOUND", "Active invite not found", 404);
    return c.body(null, 204);
  });

  app.post("/api/v1/space-invites/preview", requireScope("spaces:read"), async (c) => {
    requireUser(c.get("principal"));
    const input = await body(c);
    fields(input, ["token"]);
    const token = text(input.token, "token");
    const invite = await findInvite(c.env, token);
    const count = await memberCount(c.env, invite.space_id);
    const status = inviteStatus(invite);
    return c.json(success({
      space: { id: invite.space_id, name: invite.space_name, timezone: invite.timezone, memberCount: count },
      role: invite.role, expiresAt: invite.expires_at, canJoin: status === "active",
    }));
  });

  app.post("/api/v1/space-invites/join", requireScope("spaces:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const input = await body(c);
    fields(input, ["token", "displayName"]);
    const token = text(input.token, "token");
    const displayName = text(input.displayName, "displayName");
    const invite = await findInvite(c.env, token);
    assertInvite(invite);
    if (await findMembership(c.env, invite.space_id, principal.id)) throw new ApiError("ALREADY_SPACE_MEMBER", "User is already a Space member", 409);
    const previousMembership = await findMembership(c.env, invite.space_id, principal.id, false);
    const previousPerson = await c.env.DB.prepare(`SELECT id,deleted_at FROM space_people WHERE space_id=? AND linked_user_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(invite.space_id, principal.id).first<PersonRow>();
    const redemptionId = createId("ird");
    const redeemedAt = now();
    const membershipId = previousMembership?.id ?? createId("mem");
    const personId = previousPerson?.id ?? createId("per");
    const redemption = c.env.DB.prepare(`INSERT INTO space_invite_redemptions(id,invite_id,space_id,user_id,redeemed_at)
      SELECT ?,i.id,i.space_id,?,? FROM space_invites i JOIN spaces s ON s.id=i.space_id
      WHERE i.id=? AND i.status='active' AND julianday(i.expires_at)>julianday('now') AND i.used_count<i.max_uses AND s.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM space_memberships WHERE space_id=i.space_id AND user_id=? AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM space_invite_redemptions WHERE invite_id=i.id AND user_id=?)`)
      .bind(redemptionId, principal.id, redeemedAt, invite.id, principal.id, principal.id);
    const membership = previousMembership
      ? c.env.DB.prepare(`UPDATE space_memberships SET role=?,deleted_at=NULL,updated_at=?,version=version+1
          WHERE id=? AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(invite.role, redeemedAt, membershipId, redemptionId)
      : c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(membershipId, invite.space_id, principal.id, invite.role, redeemedAt, redeemedAt, redemptionId);
    const person = previousPerson
      ? c.env.DB.prepare(`UPDATE space_people SET display_name=?,deleted_at=NULL,updated_at=?
          WHERE id=? AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(displayName, redeemedAt, personId, redemptionId)
      : c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM space_invite_redemptions WHERE id=?)`)
        .bind(personId, invite.space_id, principal.id, displayName, redeemedAt, redeemedAt, redemptionId);
    const results = await c.env.DB.batch([redemption, membership, person]);
    if (!results[0].meta.changes) {
      const current = await findInvite(c.env, token);
      assertInvite(current);
      const priorRedemption = await c.env.DB.prepare(`SELECT 1 redeemed FROM space_invite_redemptions WHERE invite_id=? AND user_id=?`)
        .bind(current.id, principal.id).first<{ redeemed: number }>();
      if (priorRedemption) throw new ApiError("INVITE_ALREADY_REDEEMED", "Invite was already redeemed by this user", 409);
      throw new ApiError("ALREADY_SPACE_MEMBER", "User is already a Space member", 409);
    }
    return c.json(success({ spaceId: invite.space_id, role: invite.role, personId, joinedAt: redeemedAt }), 201);
  });
}
