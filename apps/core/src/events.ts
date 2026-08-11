import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type EventRow = {
  id: string;
  space_id: string;
  summary: string;
  description: string | null;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  is_all_day: number;
  start_timezone: string | null;
  end_timezone: string | null;
  location: string | null;
  status: "active" | "cancelled";
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  updated_by_type: Principal["type"];
  updated_by_id: string;
  updated_by_name_snapshot: string;
  version: number;
  created_at: string;
  updated_at: string;
  sort_key?: string;
};
type SpaceRow = { id: string; timezone: string };
type EventTime = {
  isAllDay: number;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
};
type Cursor = { v: 1; resource: "events"; sort: "start_asc"; key: string; id: string; filter: string };

const COMMON_FIELDS = ["summary", "description", "location"] as const;
const TIMED_FIELDS = ["startAt", "endAt", "startTimezone", "endTimezone"] as const;
const ALL_DAY_FIELDS = ["startDate", "endDateExclusive"] as const;
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

function fields(input: Body, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((key) => !supported.has(key))) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported event fields", 400);
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

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ApiError("INVALID_REQUEST", `${field} must be a positive integer`, 400);
  }
  return value as number;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", `${field} must be YYYY-MM-DD`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_REQUEST", `${field} must be a valid date`, 400);
  }
  return value;
}

function utcDateTime(value: unknown, field: string): string {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value)
    : null;
  const parsed = match ? new Date(value as string) : null;
  if (!match || !parsed || Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])) {
    throw new ApiError("INVALID_REQUEST", `${field} must be an RFC 3339 UTC date-time ending in Z`, 400);
  }
  return parsed.toISOString();
}

function timezone(value: unknown, field = "timezone"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_TIMEZONE", `${field} must be a valid IANA timezone`, 400);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new ApiError("INVALID_TIMEZONE", `${field} must be a valid IANA timezone`, 400);
  }
  return value;
}

function optionalTimezone(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return timezone(value, field);
}

function ids(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ApiError("INVALID_REQUEST", `${field} must contain at most ${maxItems} IDs`, 400);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw new ApiError("DUPLICATE_ATTENDEE", `${field} must not contain duplicates`, 400);
  }
  return result;
}

function eventTime(input: Body, previous?: EventRow): EventTime {
  if (!previous && typeof input.isAllDay !== "boolean") {
    throw new ApiError("INVALID_REQUEST", "isAllDay must be boolean", 400);
  }
  const isAllDay = input.isAllDay === undefined ? Boolean(previous?.is_all_day) : input.isAllDay;
  if (typeof isAllDay !== "boolean") throw new ApiError("INVALID_REQUEST", "isAllDay must be boolean", 400);
  const switching = Boolean(previous) && isAllDay !== Boolean(previous?.is_all_day);
  if (isAllDay) {
    if (TIMED_FIELDS.some((field) => input[field] !== undefined)) {
      throw new ApiError("INVALID_REQUEST", "All-day events cannot contain timed event fields", 400);
    }
    if (switching && (input.startDate === undefined || input.endDateExclusive === undefined)) {
      throw new ApiError("INVALID_REQUEST", "startDate and endDateExclusive are required when changing event type", 400);
    }
    const startDate = exactDate(input.startDate ?? previous?.start_date, "startDate");
    const endDate = exactDate(input.endDateExclusive ?? previous?.end_date, "endDateExclusive");
    if (endDate <= startDate) {
      throw new ApiError("INVALID_REQUEST", "endDateExclusive must be later than startDate", 400);
    }
    return { isAllDay: 1, startAt: null, endAt: null, startDate, endDate };
  }
  if (ALL_DAY_FIELDS.some((field) => input[field] !== undefined)) {
    throw new ApiError("INVALID_REQUEST", "Timed events cannot contain all-day event fields", 400);
  }
  if (switching && (input.startAt === undefined || input.endAt === undefined)) {
    throw new ApiError("INVALID_REQUEST", "startAt and endAt are required when changing event type", 400);
  }
  const startAt = utcDateTime(input.startAt ?? previous?.start_at, "startAt");
  const endAt = utcDateTime(input.endAt ?? previous?.end_at, "endAt");
  if (endAt <= startAt) throw new ApiError("INVALID_REQUEST", "endAt must be later than startAt", 400);
  return { isAllDay: 0, startAt, endAt, startDate: null, endDate: null };
}

function zonedMidnightUtc(date: string, timeZone: string): string {
  let instant = new Date(`${date}T00:00:00Z`);
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    instant = new Date(instant.getTime() + Date.parse(`${date}T00:00:00Z`) - represented);
  }
  return instant.toISOString();
}

function encodeCursor(value: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string): Cursor {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as Partial<Cursor>;
    if (decoded.v !== 1 || decoded.resource !== "events" || decoded.sort !== "start_asc"
      || typeof decoded.key !== "string" || typeof decoded.id !== "string" || typeof decoded.filter !== "string") throw new Error();
    return decoded as Cursor;
  } catch {
    throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) {
    throw new ApiError("INVALID_REQUEST", "limit must be an integer between 1 and 200", 400);
  }
  return Number(value);
}

async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {
  const row = await env.DB.prepare("SELECT id,timezone FROM spaces WHERE id=? AND deleted_at IS NULL")
    .bind(spaceId).first<SpaceRow>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return row;
}

async function findEvent(env: Bindings, spaceId: string, eventId: string): Promise<EventRow> {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id=? AND space_id=? AND deleted_at IS NULL")
    .bind(eventId, spaceId).first<EventRow>();
  if (!row) throw new ApiError("EVENT_NOT_FOUND", "Event not found", 404);
  return row;
}

async function actorName(env: Bindings, spaceId: string, principal: Principal): Promise<string> {
  if (principal.type !== "user") return principal.id;
  const person = await env.DB.prepare(`SELECT display_name FROM space_people
    WHERE space_id=? AND linked_user_id=? ORDER BY deleted_at IS NULL DESC,created_at DESC LIMIT 1`)
    .bind(spaceId, principal.id).first<{ display_name: string }>();
  return person?.display_name ?? principal.id;
}

async function requirePeople(env: Bindings, spaceId: string, personIds: string[]): Promise<void> {
  if (!personIds.length) return;
  const placeholders = personIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id FROM space_people WHERE space_id=? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .bind(spaceId, ...personIds).all<{ id: string }>();
  if (rows.results.length !== personIds.length) {
    throw new ApiError("INVALID_ATTENDEE", "Every attendee must be an active Space Person in the event Space", 400);
  }
}

function actorDto(type: Principal["type"], id: string, name: string) {
  return { type, id, displayName: name };
}

async function eventDto(env: Bindings, row: EventRow) {
  const attendees = await env.DB.prepare(`SELECT p.id person_id,p.display_name
    FROM event_attendees ea JOIN space_people p ON p.id=ea.person_id AND p.deleted_at IS NULL
    WHERE ea.event_id=? ORDER BY ea.created_at,p.id`)
    .bind(row.id).all<{ person_id: string; display_name: string }>();
  const common = {
    id: row.id,
    spaceId: row.space_id,
    summary: row.summary,
    description: row.description,
    isAllDay: Boolean(row.is_all_day),
    location: row.location,
    status: row.status,
    attendees: attendees.results.map((item) => ({ personId: item.person_id, displayName: item.display_name })),
    createdBy: actorDto(row.created_by_type, row.created_by_id, row.created_by_name_snapshot),
    updatedBy: actorDto(row.updated_by_type, row.updated_by_id, row.updated_by_name_snapshot),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.is_all_day
    ? { ...common, startDate: row.start_date, endDateExclusive: row.end_date }
    : { ...common, startAt: row.start_at, endAt: row.end_at, startTimezone: row.start_timezone, endTimezone: row.end_timezone };
}

async function createEvent(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const input = await body(context);
  fields(input, [...COMMON_FIELDS, ...TIMED_FIELDS, ...ALL_DAY_FIELDS, "isAllDay", "attendeePersonIds"]);
  const summary = text(input.summary, "summary", 100);
  const description = optionalText(input.description, "description", 5000) ?? null;
  const location = optionalText(input.location, "location", 500) ?? null;
  const time = eventTime(input);
  const startTimezone = time.isAllDay ? null
    : input.startTimezone === undefined ? space.timezone : optionalTimezone(input.startTimezone, "startTimezone") ?? null;
  const endTimezone = time.isAllDay ? null
    : input.endTimezone === undefined ? space.timezone : optionalTimezone(input.endTimezone, "endTimezone") ?? null;
  const personIds = input.attendeePersonIds === undefined ? [] : ids(input.attendeePersonIds, "attendeePersonIds", 100);
  await requirePeople(context.env, space.id, personIds);
  const eventId = createId("evt");
  const createdAt = now();
  const name = await actorName(context.env, space.id, principal);
  await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO events(
      id,space_id,summary,description,start_at,end_at,start_date,end_date,is_all_day,start_timezone,end_timezone,location,
      created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      eventId, space.id, summary, description, time.startAt, time.endAt, time.startDate, time.endDate, time.isAllDay,
      startTimezone, endTimezone, location, principal.type, principal.id, name, principal.type, principal.id, name, createdAt, createdAt,
    ),
    ...personIds.map((personId) => context.env.DB.prepare(
      "INSERT INTO event_attendees(event_id,person_id,created_at) VALUES(?,?,?)",
    ).bind(eventId, personId, createdAt)),
  ]);
  return context.json(success(await eventDto(context.env, await findEvent(context.env, space.id, eventId))), 201);
}

async function updateEvent(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const eventId = context.req.param("eventId");
  if (!eventId) throw new ApiError("INVALID_REQUEST", "eventId is required", 400);
  const previous = await findEvent(context.env, space.id, eventId);
  const input = await body(context);
  fields(input, [...COMMON_FIELDS, ...TIMED_FIELDS, ...ALL_DAY_FIELDS, "isAllDay", "attendeePersonIds", "version"]);
  if (Object.keys(input).length < 2) throw new ApiError("INVALID_REQUEST", "At least one event change is required", 400);
  const expected = positiveInteger(input.version, "version");
  const summary = input.summary === undefined ? previous.summary : text(input.summary, "summary", 100);
  const description = input.description === undefined ? previous.description : optionalText(input.description, "description", 5000) ?? null;
  const location = input.location === undefined ? previous.location : optionalText(input.location, "location", 500) ?? null;
  const time = eventTime(input, previous);
  const switchedToTimed = !time.isAllDay && Boolean(previous.is_all_day);
  const startTimezone = time.isAllDay ? null : input.startTimezone === undefined
    ? switchedToTimed ? space.timezone : previous.start_timezone
    : optionalTimezone(input.startTimezone, "startTimezone") ?? null;
  const endTimezone = time.isAllDay ? null : input.endTimezone === undefined
    ? switchedToTimed ? space.timezone : previous.end_timezone
    : optionalTimezone(input.endTimezone, "endTimezone") ?? null;
  const personIds = input.attendeePersonIds === undefined
    ? undefined
    : ids(input.attendeePersonIds, "attendeePersonIds", 100);
  if (personIds) await requirePeople(context.env, space.id, personIds);
  const mutationToken = crypto.randomUUID();
  const updatedAt = now();
  const name = await actorName(context.env, space.id, principal);
  const statements = [context.env.DB.prepare(`UPDATE events SET
    summary=?,description=?,start_at=?,end_at=?,start_date=?,end_date=?,is_all_day=?,start_timezone=?,end_timezone=?,location=?,
    updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1,mutation_token=?
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`).bind(
    summary, description, time.startAt, time.endAt, time.startDate, time.endDate, time.isAllDay, startTimezone, endTimezone, location,
    principal.type, principal.id, name, updatedAt, mutationToken, eventId, space.id, expected,
  )];
  if (personIds) {
    statements.push(context.env.DB.prepare(
      "DELETE FROM event_attendees WHERE event_id=? AND EXISTS(SELECT 1 FROM events WHERE id=? AND mutation_token=?)",
    ).bind(eventId, eventId, mutationToken));
    statements.push(...personIds.map((personId) => context.env.DB.prepare(
      "INSERT INTO event_attendees(event_id,person_id,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM events WHERE id=? AND mutation_token=?)",
    ).bind(eventId, personId, updatedAt, eventId, mutationToken)));
  }
  statements.push(context.env.DB.prepare("UPDATE events SET mutation_token=NULL WHERE id=? AND mutation_token=?")
    .bind(eventId, mutationToken));
  const results = await context.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new ApiError("EVENT_VERSION_CONFLICT", "Event version conflict", 409);
  return context.json(success(await eventDto(context.env, await findEvent(context.env, space.id, eventId))));
}

async function deleteEvent(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const eventId = context.req.param("eventId");
  if (!eventId) throw new ApiError("INVALID_REQUEST", "eventId is required", 400);
  await findEvent(context.env, space.id, eventId);
  const expected = positiveInteger(Number(context.req.query("version")), "version");
  const deletedAt = now();
  const result = await context.env.DB.prepare(`UPDATE events SET
    deleted_at=?,deleted_by_type=?,deleted_by_id=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`).bind(
    deletedAt, principal.type, principal.id, principal.type, principal.id,
    await actorName(context.env, space.id, principal), deletedAt, eventId, space.id, expected,
  ).run();
  if (!result.meta.changes) throw new ApiError("EVENT_VERSION_CONFLICT", "Event version conflict", 409);
  return context.body(null, 204);
}

async function attendeeFilter(context: Context<AppEnv>, spaceId: string): Promise<string | undefined> {
  let value = context.req.query("attendeePersonId");
  if (!value) return undefined;
  if (value === "me") {
    const principal = context.get("principal");
    if (principal.type !== "user") throw new ApiError("INVALID_FILTER", "me is available only for users", 400);
    const person = await context.env.DB.prepare(`SELECT id FROM space_people
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL`).bind(spaceId, principal.id).first<{ id: string }>();
    if (!person) throw new ApiError("INVALID_ATTENDEE", "Current user is not an active Space Person", 400);
    value = person.id;
  } else {
    await requirePeople(context.env, spaceId, [value]);
  }
  return value;
}

async function listEvents(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
  if (context.req.query("start") !== undefined || context.req.query("end") !== undefined) {
    throw new ApiError("INVALID_REQUEST", "Use startDate and endDateExclusive", 400);
  }
  const startQuery = context.req.query("startDate");
  const endQuery = context.req.query("endDateExclusive");
  if (!startQuery || !endQuery) throw new ApiError("INVALID_REQUEST", "startDate and endDateExclusive are required", 400);
  const startDate = exactDate(startQuery, "startDate");
  const endDate = exactDate(endQuery, "endDateExclusive");
  if (endDate <= startDate || Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`) > 366 * 86_400_000) {
    throw new ApiError("INVALID_REQUEST", "event range must be positive and at most 366 days", 400);
  }
  const viewingTimezone = context.req.query("timezone") === undefined ? space.timezone : timezone(context.req.query("timezone"));
  const rangeStartAt = zonedMidnightUtc(startDate, viewingTimezone);
  const rangeEndAt = zonedMidnightUtc(endDate, viewingTimezone);
  const status = context.req.query("status") ?? "active";
  if (status !== "active" && status !== "cancelled") throw new ApiError("INVALID_REQUEST", "status must be active or cancelled", 400);
  const query = context.req.query("q") === undefined ? undefined : text(context.req.query("q"), "q", 100);
  const personId = await attendeeFilter(context, space.id);
  const filter = JSON.stringify({ startDate, endDate, viewingTimezone, status, personId: personId ?? null, q: query ?? null });
  const cursor = context.req.query("cursor") ? decodeCursor(context.req.query("cursor")!) : undefined;
  if (cursor && cursor.filter !== filter) throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  const args: unknown[] = [space.id, status, rangeEndAt, rangeStartAt, endDate, startDate];
  let sql = `SELECT e.*,COALESCE(e.start_at,e.start_date) sort_key FROM events e
    WHERE e.space_id=? AND e.deleted_at IS NULL AND e.status=?
    AND ((e.is_all_day=0 AND e.start_at<? AND e.end_at>?) OR (e.is_all_day=1 AND e.start_date<? AND e.end_date>?))`;
  if (personId) {
    sql += " AND EXISTS(SELECT 1 FROM event_attendees ea WHERE ea.event_id=e.id AND ea.person_id=?)";
    args.push(personId);
  }
  if (query) {
    sql += " AND (instr(lower(e.summary),lower(?))>0 OR instr(lower(COALESCE(e.description,'')),lower(?))>0 OR instr(lower(COALESCE(e.location,'')),lower(?))>0)";
    args.push(query, query, query);
  }
  if (cursor) {
    sql += " AND (COALESCE(e.start_at,e.start_date)>? OR (COALESCE(e.start_at,e.start_date)=? AND e.id>?))";
    args.push(cursor.key, cursor.key, cursor.id);
  }
  const limit = parseLimit(context.req.query("limit"));
  sql += " ORDER BY sort_key ASC,e.id ASC LIMIT ?";
  args.push(limit + 1);
  const rows = await context.env.DB.prepare(sql).bind(...args).all<EventRow>();
  const page = rows.results.slice(0, limit);
  const items = await Promise.all(page.map((row) => eventDto(context.env, row)));
  const last = page.at(-1);
  const nextCursor = rows.results.length > limit && last?.sort_key
    ? encodeCursor({ v: 1, resource: "events", sort: "start_asc", key: last.sort_key, id: last.id, filter })
    : null;
  return context.json(success({ items, nextCursor }));
}

export function registerEventRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/events", requireScope("events:read"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    return listEvents(context, space);
  });
  app.post("/api/v1/spaces/:spaceId/events", requireScope("events:write"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    return createEvent(context, space);
  });
  app.get("/api/v1/spaces/:spaceId/events/:eventId", requireScope("events:read"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
    return context.json(success(await eventDto(context.env, await findEvent(context.env, space.id, context.req.param("eventId")))));
  });
  app.patch("/api/v1/spaces/:spaceId/events/:eventId", requireScope("events:write"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    return updateEvent(context, space);
  });
  app.delete("/api/v1/spaces/:spaceId/events/:eventId", requireScope("events:write"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    return deleteEvent(context, space);
  });
}
