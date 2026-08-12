import type { Bindings, Principal } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { getTypedResourcesByIds } from "./typed-resource-batch";
import { typedScalarExpression, typedTableSql } from "./typed-resource-storage";

type Cursor = { v: 1; modelKey: string; signature: string; sort: string; key: string; id: string };
type Row = { id: string; sort_key: string };

function encode(value: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(raw: string, modelKey: string, signature: string, sort: string): Cursor {
  try {
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Cursor;
    if (value.v !== 1 || value.modelKey !== modelKey || value.signature !== signature || value.sort !== sort || typeof value.key !== "string" || typeof value.id !== "string") throw new Error();
    return value;
  } catch { throw new ApiError("INVALID_QUERY", "cursor is invalid for this Calendar query", 400); }
}
function signature(params: URLSearchParams) { return JSON.stringify([...params.entries()].filter(([key]) => key !== "cursor" && key !== "limit").sort()); }
function limit(raw: string | null) {
  if (raw === null) return 100;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
  return Number(raw);
}
function instant(value: string, field: string) {
  const parsed = new Date(value);
  if (!/T/u.test(value) || Number.isNaN(parsed.getTime())) throw new ApiError("INVALID_QUERY", `${field} must be RFC 3339`, 400);
  return parsed.toISOString();
}
function date(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApiError("INVALID_QUERY", `${field} must be YYYY-MM-DD`, 400);
  return value;
}
async function mePerson(env: Bindings, principal: Principal, spaceId: string) {
  if (principal.type !== "user") throw new ApiError("INVALID_QUERY", "me requires a user principal", 400);
  const row = await env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId, principal.id).first<{ id: string }>();
  if (!row) throw new ApiError("INVALID_QUERY", "me requires an active Space Person", 400);
  return row.id;
}

export function isCalendarSpecialQuery(model: PublishedModel, params: URLSearchParams) {
  if (!model.definition.capabilities?.calendar) return false;
  const sort = params.get("sort");
  const attendee = model.definition.capabilities.calendar.attendeePersonField;
  return params.has("rangeStart") || params.has("rangeEnd") || params.has("dateStart") || params.has("dateEndExclusive")
    || (attendee ? params.get(attendee) === "me" : false) || sort === "calendarStart:asc" || sort === "calendarStart:desc";
}

export async function queryCalendarResources(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, params: URLSearchParams): Promise<{ items: GenericResource[]; nextCursor: string | null }> {
  const c = model.definition.capabilities?.calendar;
  if (!c) throw new ApiError("CALENDAR_CAPABILITY_NOT_ENABLED", "Calendar capability is required", 400);
  const allowed = new Set(["q", "status", "rangeStart", "rangeEnd", "dateStart", "dateEndExclusive", "sort", "limit", "cursor", ...(c.attendeePersonField ? [c.attendeePersonField] : [])]);
  for (const key of params.keys()) if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Query parameter ${key} is not supported by Calendar query`, 400);
  const rangeStartRaw = params.get("rangeStart"), rangeEndRaw = params.get("rangeEnd"), dateStartRaw = params.get("dateStart"), dateEndRaw = params.get("dateEndExclusive");
  if (Boolean(rangeStartRaw) !== Boolean(rangeEndRaw)) throw new ApiError("INVALID_QUERY", "rangeStart and rangeEnd must be provided together", 400);
  if (Boolean(dateStartRaw) !== Boolean(dateEndRaw)) throw new ApiError("INVALID_QUERY", "dateStart and dateEndExclusive must be provided together", 400);
  const rangeStart = rangeStartRaw ? instant(rangeStartRaw, "rangeStart") : null;
  const rangeEnd = rangeEndRaw ? instant(rangeEndRaw, "rangeEnd") : null;
  if (rangeStart && rangeEnd && rangeEnd <= rangeStart) throw new ApiError("INVALID_QUERY", "rangeEnd must be later than rangeStart", 400);
  const dateStart = dateStartRaw ? date(dateStartRaw, "dateStart") : null;
  const dateEnd = dateEndRaw ? date(dateEndRaw, "dateEndExclusive") : null;
  if (dateStart && dateEnd && dateEnd <= dateStart) throw new ApiError("INVALID_QUERY", "dateEndExclusive must be later than dateStart", 400);
  let attendee = c.attendeePersonField ? params.get(c.attendeePersonField) : null;
  if (attendee === "me") attendee = await mePerson(env, principal, spaceId);
  const sort = params.get("sort") ?? "calendarStart:asc";
  if (!["calendarStart:asc", "calendarStart:desc"].includes(sort)) throw new ApiError("INVALID_QUERY", "Unsupported Calendar sort", 400);
  const s = (field: string) => typedScalarExpression(model, field, "m");
  const allDay = s(c.allDayField);
  const startAt = s(c.timedStartField);
  const endAt = s(c.timedEndField);
  const startDate = s(c.allDayStartField);
  const endDate = s(c.allDayEndExclusiveField);
  const where = ["r.space_id=?", "r.model_key=?", "r.deleted_at IS NULL"];
  const args: unknown[] = [spaceId, model.key];
  if (rangeStart || dateStart) {
    const overlap: string[] = [];
    if (rangeStart && rangeEnd) { overlap.push(`(${allDay}=0 AND ${startAt}<? AND ${endAt}>?)`); args.push(rangeEnd, rangeStart); }
    if (dateStart && dateEnd) { overlap.push(`(${allDay}=1 AND ${startDate}<? AND ${endDate}>?)`); args.push(dateEnd, dateStart); }
    where.push(`(${overlap.join(" OR ")})`);
  }
  if (params.get("status")) { where.push(`${s("status") }=?`); args.push(params.get("status")); }
  if (attendee && c.attendeePersonField) {
    where.push("EXISTS(SELECT 1 FROM resource_relations rr WHERE rr.source_record_id=r.id AND rr.field_key=? AND rr.target_type='person' AND rr.target_person_id=?)");
    args.push(c.attendeePersonField, attendee);
  }
  const q = params.get("q")?.trim();
  if (q) {
    const fields = model.definition.query?.searchable ?? [];
    where.push(`(${fields.map((field) => `instr(lower(COALESCE(${s(field)},'')),lower(?))>0`).join(" OR ")})`);
    args.push(...fields.map(() => q));
  }
  const sortExpr = `CASE WHEN ${allDay}=1 THEN ${startDate} ELSE ${startAt} END`;
  const sig = signature(params);
  const cursor = params.get("cursor") ? decode(params.get("cursor")!, model.key, sig, sort) : null;
  const asc = sort.endsWith(":asc");
  if (cursor) { const op = asc ? ">" : "<"; where.push(`(${sortExpr}${op}? OR (${sortExpr}=? AND r.id${op}?))`); args.push(cursor.key, cursor.key, cursor.id); }
  const pageLimit = limit(params.get("limit")); args.push(pageLimit + 1);
  const rows = await env.DB.prepare(`SELECT r.id,${sortExpr} sort_key
    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE ${where.join(" AND ")} ORDER BY sort_key ${asc ? "ASC" : "DESC"},r.id ${asc ? "ASC" : "DESC"} LIMIT ?`)
    .bind(...args).all<Row>();
  const page = rows.results.slice(0, pageLimit);
  const items = await getTypedResourcesByIds(env, spaceId, model, page.map((row) => row.id));
  const last = page.at(-1);
  return { items, nextCursor: rows.results.length > pageLimit && last ? encode({ v: 1, modelKey: model.key, signature: sig, sort, key: last.sort_key, id: last.id }) : null };
}
