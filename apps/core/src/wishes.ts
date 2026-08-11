import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type WishStatus = "open" | "claimed" | "fulfilled" | "archived";
type WishSort = "default" | "desired_asc" | "created_desc" | "updated_desc";
type SpaceRow = { id: string };
type LegacyFamilyRow = { legacy_family_id: string; space_id: string };
type PersonRow = { id: string; display_name: string };
type WishRow = {
  id: string;
  space_id: string;
  owner_person_id: string;
  title: string;
  description: string | null;
  desired_date: string | null;
  status: WishStatus;
  claimant_person_id: string | null;
  claimed_at: string | null;
  fulfilled_by_person_id: string | null;
  fulfilled_at: string | null;
  archived_from_status: Exclude<WishStatus, "archived"> | null;
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  updated_by_type: Principal["type"];
  updated_by_id: string;
  updated_by_name_snapshot: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by_type: Principal["type"] | null;
  deleted_by_id: string | null;
  mutation_token: string | null;
};
type Cursor = {
  v: 1;
  resource: "wishes";
  sort: WishSort;
  key: string;
  id: string;
  filter: string;
};

const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const NO_MATCH_PERSON = "__wish_filter_no_match__";

async function body(context: Context<AppEnv>): Promise<Body> {
  let value: unknown;
  try { value = await context.req.json(); }
  catch { throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be an object", 400);
  return value as Body;
}

function fields(input: Body, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((field) => !supported.has(field))) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported wish fields", 400);
  }
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError("INVALID_REQUEST", `${field} must contain 1-${maxLength} characters`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ApiError("INVALID_REQUEST", `${field} must be a string up to ${maxLength} characters or null`, 400);
  }
  return value.trim() || null;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", `${field} must be a valid YYYY-MM-DD date`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_REQUEST", `${field} must be a valid YYYY-MM-DD date`, 400);
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return exactDate(value, field);
}

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
  return value as number;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) {
    throw new ApiError("INVALID_REQUEST", "limit must be an integer between 1 and 200", 400);
  }
  return Number(value);
}

function encodeCursor(value: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string, sort: WishSort): Cursor {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as Partial<Cursor>;
    if (decoded.v !== 1 || decoded.resource !== "wishes" || decoded.sort !== sort || typeof decoded.key !== "string" || typeof decoded.id !== "string" || typeof decoded.filter !== "string") throw new Error();
    return decoded as Cursor;
  } catch {
    throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  }
}

function statuses(value: string | undefined): WishStatus[] {
  const result = value?.split(",") ?? ["open", "claimed", "fulfilled"];
  if (!result.length || new Set(result).size !== result.length || result.some((item) => !["open", "claimed", "fulfilled", "archived"].includes(item))) {
    throw new ApiError("INVALID_REQUEST", "status is invalid", 400);
  }
  return result as WishStatus[];
}

function sortKey(row: WishRow, sort: WishSort): string {
  if (sort === "default") {
    const rank: Record<WishStatus, string> = { open: "0", claimed: "1", fulfilled: "2", archived: "3" };
    return `${rank[row.status]}|${row.desired_date ?? "9999-12-31"}|${row.created_at}`;
  }
  if (sort === "desired_asc") return `${row.desired_date ?? "9999-12-31"}|${row.created_at}`;
  return sort === "created_desc" ? row.created_at : row.updated_at;
}

function compareTuple(aKey: string, aId: string, bKey: string, bId: string, descending: boolean): number {
  const key = aKey.localeCompare(bKey);
  const id = aId.localeCompare(bId);
  return descending ? -(key || id) : key || id;
}

async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {
  const row = await env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId).first<SpaceRow>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return row;
}

async function findFamily(env: Bindings, familyId: string): Promise<LegacyFamilyRow> {
  const row = await env.DB.prepare(`SELECT fm.legacy_family_id,fm.space_id
    FROM legacy_homemew_family_maps fm JOIN spaces s ON s.id=fm.space_id
    WHERE fm.legacy_family_id=? AND s.kind='family' AND s.deleted_at IS NULL`)
    .bind(familyId).first<LegacyFamilyRow>();
  if (!row) throw new ApiError("FAMILY_NOT_FOUND", "Family not found", 404);
  return row;
}

async function findWish(env: Bindings, spaceId: string, wishId: string): Promise<WishRow> {
  const row = await env.DB.prepare("SELECT * FROM wishes WHERE id=? AND space_id=? AND deleted_at IS NULL")
    .bind(wishId, spaceId).first<WishRow>();
  if (!row) throw new ApiError("WISH_NOT_FOUND", "Wish not found", 404);
  return row;
}

async function currentPerson(env: Bindings, principal: Principal, spaceId: string): Promise<PersonRow> {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "Only Space members can access wishes", 403);
  const person = await env.DB.prepare(`SELECT id,display_name FROM space_people
    WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1`)
    .bind(spaceId, principal.id).first<PersonRow>();
  if (!person) throw new ApiError("FORBIDDEN", "Only active Space members can access wishes", 403);
  return person;
}

async function actorName(env: Bindings, spaceId: string, principal: Principal): Promise<string> {
  if (principal.type !== "user") return principal.id;
  const person = await env.DB.prepare(`SELECT display_name FROM space_people
    WHERE space_id=? AND linked_user_id=? ORDER BY deleted_at IS NULL DESC,created_at DESC LIMIT 1`)
    .bind(spaceId, principal.id).first<{ display_name: string }>();
  if (person) return person.display_name;
  const legacy = await env.DB.prepare("SELECT display_name_snapshot FROM legacy_homemew_user_maps WHERE lifespace_user_id=?")
    .bind(principal.id).first<{ display_name_snapshot: string }>();
  return legacy?.display_name_snapshot ?? principal.id;
}

async function actorDto(env: Bindings, type: Principal["type"], id: string, name: string, legacy: boolean) {
  if (!legacy) return { type, id, displayName: name };
  if (type === "user") {
    const mapping = await env.DB.prepare("SELECT legacy_user_id FROM legacy_homemew_user_maps WHERE lifespace_user_id=?")
      .bind(id).first<{ legacy_user_id: string }>();
    return { type: "user", id: mapping?.legacy_user_id ?? id, name, avatarUrl: null };
  }
  return { type: "system", id, name, avatarUrl: null };
}

async function personDto(env: Bindings, spaceId: string, personId: string | null, legacyFamilyId?: string) {
  if (!personId) return null;
  const person = await env.DB.prepare("SELECT id,display_name FROM space_people WHERE id=? AND space_id=?")
    .bind(personId, spaceId).first<PersonRow>();
  if (!person) return null;
  if (!legacyFamilyId) return { personId: person.id, displayName: person.display_name };
  const mapping = await env.DB.prepare(`SELECT legacy_user_id FROM legacy_homemew_membership_maps
    WHERE legacy_family_id=? AND person_id=?`).bind(legacyFamilyId, personId).first<{ legacy_user_id: string }>();
  if (!mapping) return null;
  return { userId: mapping.legacy_user_id, displayName: person.display_name, avatarUrl: null };
}

async function wishDto(env: Bindings, row: WishRow, legacyFamilyId?: string) {
  const legacy = Boolean(legacyFamilyId);
  return {
    id: row.id,
    ...(legacy ? { familyId: legacyFamilyId } : { spaceId: row.space_id }),
    title: row.title,
    description: row.description,
    desiredDate: row.desired_date,
    status: row.status,
    owner: await personDto(env, row.space_id, row.owner_person_id, legacyFamilyId),
    claimant: await personDto(env, row.space_id, row.claimant_person_id, legacyFamilyId),
    claimedAt: row.claimed_at,
    fulfilledBy: await personDto(env, row.space_id, row.fulfilled_by_person_id, legacyFamilyId),
    fulfilledAt: row.fulfilled_at,
    createdBy: await actorDto(env, row.created_by_type, row.created_by_id, row.created_by_name_snapshot, legacy),
    updatedBy: await actorDto(env, row.updated_by_type, row.updated_by_id, row.updated_by_name_snapshot, legacy),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireOwner(row: WishRow, personId: string): void {
  if (row.owner_person_id !== personId) throw new ApiError("WISH_OWNER_REQUIRED", "Only the wish owner can perform this action", 403);
}

function assertVersion(row: WishRow, expected: number): void {
  if (row.version !== expected) throw new ApiError("VERSION_CONFLICT", "Wish version conflict", 409);
}

async function legacyFilterPerson(env: Bindings, familyId: string, value: string | undefined, currentPersonId: string, field: string): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === "me") return currentPersonId;
  if (!/^usr_/.test(value)) throw new ApiError("INVALID_REQUEST", `${field} must be a user ID or me`, 400);
  const mapping = await env.DB.prepare(`SELECT person_id FROM legacy_homemew_membership_maps
    WHERE legacy_family_id=? AND legacy_user_id=?`).bind(familyId, value).first<{ person_id: string }>();
  return mapping?.person_id ?? NO_MATCH_PERSON;
}

function nativeFilterPerson(value: string | undefined, currentPersonId: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "me") return currentPersonId;
  if (!/^per_/.test(value)) throw new ApiError("INVALID_REQUEST", `${field} must be a Space Person ID or me`, 400);
  return value;
}

async function requireWishAccess(context: Context<AppEnv>, space: SpaceRow, permission: "read" | "write"): Promise<PersonRow> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, permission);
  return currentPerson(context.env, principal, space.id);
}

async function createWish(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  const person = await requireWishAccess(context, space, "write");
  const input = await body(context);
  fields(input, ["title", "description", "desiredDate"]);
  const title = text(input.title, "title", 100);
  const description = optionalText(input.description, "description", 5000) ?? null;
  const desiredDate = optionalDate(input.desiredDate, "desiredDate");
  const wishId = createId("wsh");
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  await context.env.DB.prepare(`INSERT INTO wishes(
    id,space_id,owner_person_id,title,description,desired_date,
    created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(wishId, space.id, person.id, title, description, desiredDate,
      principal.type, principal.id, actor, principal.type, principal.id, actor, timestamp, timestamp).run();
  return context.json(success(await wishDto(context.env, await findWish(context.env, space.id, wishId), legacyFamilyId)), 201);
}

async function readWish(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  await requireWishAccess(context, space, "read");
  return context.json(success(await wishDto(context.env, await findWish(context.env, space.id, context.req.param("wishId")!), legacyFamilyId)));
}

async function updateWish(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  const person = await requireWishAccess(context, space, "write");
  const wishId = context.req.param("wishId")!;
  const previous = await findWish(context.env, space.id, wishId);
  requireOwner(previous, person.id);
  if (previous.status === "archived") throw new ApiError("WISH_ARCHIVED", "Archived wishes are read-only", 409);
  const input = await body(context);
  fields(input, ["title", "description", "desiredDate", "version"]);
  const expected = version(input.version);
  assertVersion(previous, expected);
  if (Object.keys(input).length < 2) throw new ApiError("INVALID_REQUEST", "At least one wish change is required", 400);
  const title = input.title === undefined ? previous.title : text(input.title, "title", 100);
  const description = input.description === undefined ? previous.description : optionalText(input.description, "description", 5000) ?? null;
  const desiredDate = input.desiredDate === undefined ? previous.desired_date : optionalDate(input.desiredDate, "desiredDate");
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE wishes SET title=?,description=?,desired_date=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND status!='archived' AND version=?`)
    .bind(title, description, desiredDate, principal.type, principal.id, actor, timestamp, wishId, space.id, expected).run();
  if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", "Wish version conflict", 409);
  return context.json(success(await wishDto(context.env, await findWish(context.env, space.id, wishId), legacyFamilyId)));
}

async function deleteWish(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  const person = await requireWishAccess(context, space, "write");
  const wishId = context.req.param("wishId")!;
  const previous = await findWish(context.env, space.id, wishId);
  requireOwner(previous, person.id);
  const expected = version(Number(context.req.query("version")));
  assertVersion(previous, expected);
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE wishes SET deleted_at=?,deleted_by_type=?,deleted_by_id=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
    .bind(timestamp, principal.type, principal.id, principal.type, principal.id, actor, timestamp, wishId, space.id, expected).run();
  if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", "Wish version conflict", 409);
  return context.body(null, 204);
}

async function actionWish(
  context: Context<AppEnv>,
  space: SpaceRow,
  kind: "claim" | "unclaim" | "fulfill" | "reopen" | "archive" | "restore",
  legacyFamilyId?: string,
): Promise<Response> {
  const principal = context.get("principal");
  const person = await requireWishAccess(context, space, "write");
  const wishId = context.req.param("wishId")!;
  const input = await body(context);
  fields(input, ["version"]);
  const expected = version(input.version);
  const row = await findWish(context.env, space.id, wishId);
  assertVersion(row, expected);
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  let sql = "";
  let args: unknown[] = [];

  if (kind === "claim") {
    if (row.status !== "open") throw new ApiError("WISH_NOT_OPEN", "Only open wishes can be claimed", 409);
    if (row.owner_person_id === person.id) throw new ApiError("WISH_CANNOT_CLAIM_OWN", "A member cannot claim their own wish", 409);
    sql = `UPDATE wishes SET status='claimed',claimant_person_id=?,claimed_at=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='open' AND version=?`;
    args = [person.id, timestamp, principal.type, principal.id, actor, timestamp, wishId, space.id, expected];
  } else if (kind === "unclaim") {
    if (row.status !== "claimed" || row.claimant_person_id !== person.id) throw new ApiError("WISH_CLAIMANT_REQUIRED", "Only the current claimant can release this wish", 403);
    sql = `UPDATE wishes SET status='open',claimant_person_id=NULL,claimed_at=NULL,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='claimed' AND claimant_person_id=? AND version=?`;
    args = [principal.type, principal.id, actor, timestamp, wishId, space.id, person.id, expected];
  } else if (kind === "fulfill") {
    if (row.status === "archived" || row.status === "fulfilled") throw new ApiError("WISH_INVALID_STATE", "Wish cannot be fulfilled from its current state", 409);
    if (row.owner_person_id !== person.id && row.claimant_person_id !== person.id) throw new ApiError("WISH_FULFILLER_REQUIRED", "Only the owner or current claimant can fulfill this wish", 403);
    sql = `UPDATE wishes SET status='fulfilled',fulfilled_by_person_id=?,fulfilled_at=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status IN ('open','claimed') AND version=?`;
    args = [person.id, timestamp, principal.type, principal.id, actor, timestamp, wishId, space.id, expected];
  } else if (kind === "reopen") {
    requireOwner(row, person.id);
    if (row.status !== "fulfilled") throw new ApiError("WISH_INVALID_STATE", "Only fulfilled wishes can be reopened", 409);
    sql = `UPDATE wishes SET status='open',claimant_person_id=NULL,claimed_at=NULL,fulfilled_by_person_id=NULL,fulfilled_at=NULL,
      updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='fulfilled' AND version=?`;
    args = [principal.type, principal.id, actor, timestamp, wishId, space.id, expected];
  } else if (kind === "archive") {
    requireOwner(row, person.id);
    if (row.status === "archived") throw new ApiError("WISH_ARCHIVED", "Wish is already archived", 409);
    sql = `UPDATE wishes SET archived_from_status=status,status='archived',updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status!='archived' AND version=?`;
    args = [principal.type, principal.id, actor, timestamp, wishId, space.id, expected];
  } else {
    requireOwner(row, person.id);
    if (row.status !== "archived") throw new ApiError("WISH_NOT_ARCHIVED", "Wish is not archived", 409);
    let target = row.archived_from_status ?? "open";
    let claimant = row.claimant_person_id;
    let claimedAt = row.claimed_at;
    if (target === "claimed") {
      const active = claimant ? await context.env.DB.prepare("SELECT 1 ok FROM space_people WHERE id=? AND space_id=? AND deleted_at IS NULL")
        .bind(claimant, space.id).first<{ ok: number }>() : null;
      if (!active) {
        target = "open";
        claimant = null;
        claimedAt = null;
      }
    }
    sql = `UPDATE wishes SET status=?,archived_from_status=NULL,claimant_person_id=?,claimed_at=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='archived' AND version=?`;
    args = [target, claimant, claimedAt, principal.type, principal.id, actor, timestamp, wishId, space.id, expected];
  }

  const result = await context.env.DB.prepare(sql).bind(...args).run();
  if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", "Wish version conflict", 409);
  return context.json(success(await wishDto(context.env, await findWish(context.env, space.id, wishId), legacyFamilyId)));
}

async function listWishes(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const current = await requireWishAccess(context, space, "read");
  const selectedStatuses = statuses(context.req.query("status"));
  const ownerField = legacyFamilyId ? "ownerUserId" : "ownerPersonId";
  const claimantField = legacyFamilyId ? "claimantUserId" : "claimantPersonId";
  const owner = legacyFamilyId
    ? await legacyFilterPerson(context.env, legacyFamilyId, context.req.query(ownerField), current.id, ownerField)
    : nativeFilterPerson(context.req.query(ownerField), current.id, ownerField);
  const claimant = legacyFamilyId
    ? await legacyFilterPerson(context.env, legacyFamilyId, context.req.query(claimantField), current.id, claimantField)
    : nativeFilterPerson(context.req.query(claimantField), current.id, claimantField);
  const desiredFrom = context.req.query("desiredFrom") === undefined ? undefined : exactDate(context.req.query("desiredFrom"), "desiredFrom");
  const desiredTo = context.req.query("desiredTo") === undefined ? undefined : exactDate(context.req.query("desiredTo"), "desiredTo");
  if (desiredFrom && desiredTo && desiredFrom > desiredTo) throw new ApiError("INVALID_REQUEST", "desiredFrom must not be after desiredTo", 400);
  const sort = (context.req.query("sort") ?? "default") as WishSort;
  if (!["default", "desired_asc", "created_desc", "updated_desc"].includes(sort)) throw new ApiError("INVALID_REQUEST", "sort is invalid", 400);
  const filter = JSON.stringify({ statuses: selectedStatuses, owner: owner ?? null, claimant: claimant ?? null, desiredFrom: desiredFrom ?? null, desiredTo: desiredTo ?? null });
  const cursor = context.req.query("cursor") ? decodeCursor(context.req.query("cursor")!, sort) : undefined;
  if (cursor && cursor.filter !== filter) throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);

  const marks = selectedStatuses.map(() => "?").join(",");
  const args: unknown[] = [space.id, ...selectedStatuses];
  let sql = `SELECT * FROM wishes WHERE space_id=? AND deleted_at IS NULL AND status IN (${marks})`;
  if (owner) { sql += " AND owner_person_id=?"; args.push(owner); }
  if (claimant) { sql += " AND claimant_person_id=?"; args.push(claimant); }
  if (desiredFrom) { sql += " AND desired_date>=?"; args.push(desiredFrom); }
  if (desiredTo) { sql += " AND desired_date<=?"; args.push(desiredTo); }
  let rows = (await context.env.DB.prepare(sql).bind(...args).all<WishRow>()).results;
  const descending = sort === "created_desc" || sort === "updated_desc";
  rows.sort((a, b) => compareTuple(sortKey(a, sort), a.id, sortKey(b, sort), b.id, descending));
  if (cursor) rows = rows.filter((row) => compareTuple(sortKey(row, sort), row.id, cursor.key, cursor.id, descending) > 0);
  const limit = parseLimit(context.req.query("limit"));
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page.at(-1);
  return context.json(success({
    items: await Promise.all(page.map((row) => wishDto(context.env, row, legacyFamilyId))),
    nextCursor: hasMore && last ? encodeCursor({ v: 1, resource: "wishes", sort, key: sortKey(last, sort), id: last.id, filter }) : null,
  }));
}

export function registerWishRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/wishes", requireScope("wishes:read"), async (context) =>
    listWishes(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/wishes", requireScope("wishes:write"), async (context) =>
    createWish(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.get("/api/v1/spaces/:spaceId/wishes/:wishId", requireScope("wishes:read"), async (context) =>
    readWish(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.patch("/api/v1/spaces/:spaceId/wishes/:wishId", requireScope("wishes:write"), async (context) =>
    updateWish(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.delete("/api/v1/spaces/:spaceId/wishes/:wishId", requireScope("wishes:write"), async (context) =>
    deleteWish(context, await findSpace(context.env, context.req.param("spaceId"))));
  for (const kind of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"] as const) {
    app.post(`/api/v1/spaces/:spaceId/wishes/:wishId/${kind}`, requireScope("wishes:write"), async (context) =>
      actionWish(context, await findSpace(context.env, context.req.param("spaceId")), kind));
  }

  app.get("/api/v1/families/:familyId/wishes", requireScope("wishes:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return listWishes(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/wishes", requireScope("wishes:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return createWish(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.get("/api/v1/families/:familyId/wishes/:wishId", requireScope("wishes:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return readWish(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.patch("/api/v1/families/:familyId/wishes/:wishId", requireScope("wishes:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return updateWish(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.delete("/api/v1/families/:familyId/wishes/:wishId", requireScope("wishes:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return deleteWish(context, { id: family.space_id });
  });
  for (const kind of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"] as const) {
    app.post(`/api/v1/families/:familyId/wishes/:wishId/${kind}`, requireScope("wishes:write"), async (context) => {
      const family = await findFamily(context.env, context.req.param("familyId"));
      return actionWish(context, { id: family.space_id }, kind, family.legacy_family_id);
    });
  }
}
