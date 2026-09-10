import type { Bindings, Principal } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { instantToLocalDate, localDateWindowToInstantRange } from "./time-semantics";
import {
  hydrateTypedResourceRows,
  typedScalarExpression,
  typedSelectColumns,
  typedTableSql,
  type TypedResourceRow,
} from "./typed-resource-storage";

type LegacyCursor = { v: 1; modelKey: string; signature: string; sort: string; key: string; id: string };
type ViewingStreamCursor = { start: string; id: string };
type ViewingCursor = {
  v: 2;
  modelKey: string;
  signature: string;
  sort: string;
  allDay?: ViewingStreamCursor;
  timed?: ViewingStreamCursor;
};
type LegacyRow = TypedResourceRow & { sort_key: string };
type ViewingRow = TypedResourceRow & { stream_start: string };
type ViewingCandidate = {
  kind: "allDay" | "timed";
  localDate: string;
  start: string;
  row: ViewingRow;
};

const CALENDAR_SORTS = new Set(["calendarStart:asc", "calendarStart:desc"]);
const LEGACY_WINDOW_PARAMETERS = ["rangeStart", "rangeEnd", "dateStart", "dateEndExclusive"] as const;
const VIEWING_WINDOW_PARAMETERS = ["windowStartDate", "windowEndDateExclusive", "viewingTimezone"] as const;

function encode(value: LegacyCursor | ViewingCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBytes(raw: string): unknown {
  const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeLegacy(raw: string, modelKey: string, querySignature: string, sort: string): LegacyCursor {
  try {
    const value = decodeBytes(raw) as LegacyCursor;
    if (
      value.v !== 1
      || value.modelKey !== modelKey
      || value.signature !== querySignature
      || value.sort !== sort
      || typeof value.key !== "string"
      || typeof value.id !== "string"
    ) throw new Error();
    return value;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid for this Calendar query", 400);
  }
}

function validStreamCursor(value: unknown): value is ViewingStreamCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ViewingStreamCursor>;
  return typeof candidate.start === "string" && typeof candidate.id === "string";
}

function decodeViewing(raw: string, modelKey: string, querySignature: string, sort: string): ViewingCursor {
  try {
    const value = decodeBytes(raw) as ViewingCursor;
    if (
      value.v !== 2
      || value.modelKey !== modelKey
      || value.signature !== querySignature
      || value.sort !== sort
      || (value.allDay !== undefined && !validStreamCursor(value.allDay))
      || (value.timed !== undefined && !validStreamCursor(value.timed))
    ) throw new Error();
    return value;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid for this Calendar viewing-window query", 400);
  }
}

function signature(params: URLSearchParams) {
  return JSON.stringify([...params.entries()].filter(([key]) => key !== "cursor" && key !== "limit").sort());
}

function limit(raw: string | null) {
  if (raw === null) return 100;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 200) {
    throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
  }
  return Number(raw);
}

function instant(value: string, field: string) {
  const parsed = new Date(value);
  if (!/T/u.test(value) || Number.isNaN(parsed.getTime())) {
    throw new ApiError("INVALID_QUERY", `${field} must be RFC 3339`, 400);
  }
  return parsed.toISOString();
}

function date(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApiError("INVALID_QUERY", `${field} must be YYYY-MM-DD`, 400);
  return value;
}

async function mePerson(env: Bindings, principal: Principal, spaceId: string) {
  if (principal.type !== "user") throw new ApiError("INVALID_QUERY", "me requires a user principal", 400);
  const row = await env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1")
    .bind(spaceId, principal.id)
    .first<{ id: string }>();
  if (!row) throw new ApiError("INVALID_QUERY", "me requires an active Space Person", 400);
  return row.id;
}

function semanticSort(params: URLSearchParams): string {
  const sorts = params.getAll("sort");
  if (sorts.length > 1) throw new ApiError("INVALID_QUERY", "Calendar semantic query accepts exactly one standalone sort criterion", 400);
  const sort = sorts[0] ?? "calendarStart:asc";
  if (!CALENDAR_SORTS.has(sort)) throw new ApiError("INVALID_QUERY", "Unsupported Calendar sort", 400);
  return sort;
}

function textCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function viewingCandidateCompare(left: ViewingCandidate, right: ViewingCandidate, asc: boolean): number {
  const dateOrder = textCompare(left.localDate, right.localDate);
  if (dateOrder) return asc ? dateOrder : -dateOrder;
  if (left.kind !== right.kind) return left.kind === "allDay" ? -1 : 1;
  const startOrder = textCompare(left.start, right.start);
  if (startOrder) return asc ? startOrder : -startOrder;
  return textCompare(left.row.id, right.row.id);
}

export function isCalendarSpecialQuery(model: PublishedModel, params: URLSearchParams) {
  if (!model.definition.capabilities?.calendar) return false;
  const sorts = params.getAll("sort");
  const attendee = model.definition.capabilities.calendar.attendeePersonField;
  return LEGACY_WINDOW_PARAMETERS.some((parameter) => params.has(parameter))
    || VIEWING_WINDOW_PARAMETERS.some((parameter) => params.has(parameter))
    || (attendee ? params.get(attendee) === "me" : false)
    || sorts.some((sort) => CALENDAR_SORTS.has(sort));
}

async function queryLegacyCalendarResources(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  params: URLSearchParams,
): Promise<{ items: GenericResource[]; nextCursor: string | null }> {
  const c = model.definition.capabilities?.calendar;
  if (!c) throw new ApiError("CALENDAR_CAPABILITY_NOT_ENABLED", "Calendar capability is required", 400);
  const allowed = new Set([
    "q", "status", "rangeStart", "rangeEnd", "dateStart", "dateEndExclusive", "sort", "limit", "cursor",
    ...(c.attendeePersonField ? [c.attendeePersonField] : []),
  ]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Query parameter ${key} is not supported by Calendar query`, 400);
  }

  const rangeStartRaw = params.get("rangeStart");
  const rangeEndRaw = params.get("rangeEnd");
  const dateStartRaw = params.get("dateStart");
  const dateEndRaw = params.get("dateEndExclusive");
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
  const sort = semanticSort(params);
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
    if (rangeStart && rangeEnd) {
      overlap.push(`(${allDay}=0 AND ${startAt}<? AND ${endAt}>?)`);
      args.push(rangeEnd, rangeStart);
    }
    if (dateStart && dateEnd) {
      overlap.push(`(${allDay}=1 AND ${startDate}<? AND ${endDate}>?)`);
      args.push(dateEnd, dateStart);
    }
    where.push(`(${overlap.join(" OR ")})`);
  }
  if (params.get("status")) {
    where.push(`${s("status") }=?`);
    args.push(params.get("status"));
  }
  if (attendee && c.attendeePersonField) {
    where.push("EXISTS(SELECT 1 FROM resource_relations rr WHERE rr.source_record_id=r.id AND rr.field_key=? AND rr.target_type='person' AND rr.target_person_id=?)");
    args.push(c.attendeePersonField, attendee);
  }
  const q = params.get("q")?.trim();
  if (q) {
    const fields = model.definition.query?.searchable ?? [];
    if (!fields.length) throw new ApiError("INVALID_QUERY", `Model ${model.key} does not expose searchable fields`, 400);
    where.push(`(${fields.map((field) => `instr(lower(COALESCE(${s(field)},'')),lower(?))>0`).join(" OR ")})`);
    args.push(...fields.map(() => q));
  }

  const sortExpr = `CASE WHEN ${allDay}=1 THEN ${startDate} ELSE ${startAt} END`;
  const sig = signature(params);
  const cursor = params.get("cursor") ? decodeLegacy(params.get("cursor")!, model.key, sig, sort) : null;
  const asc = sort.endsWith(":asc");
  if (cursor) {
    const op = asc ? ">" : "<";
    where.push(`(${sortExpr}${op}? OR (${sortExpr}=? AND r.id${op}?))`);
    args.push(cursor.key, cursor.key, cursor.id);
  }
  const pageLimit = limit(params.get("limit"));
  args.push(pageLimit + 1);
  const scalarSelect = typedSelectColumns(model);
  const rows = await env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""},${sortExpr} sort_key
    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE ${where.join(" AND ")} ORDER BY sort_key ${asc ? "ASC" : "DESC"},r.id ${asc ? "ASC" : "DESC"} LIMIT ?`)
    .bind(...args)
    .all<LegacyRow>();
  const page = rows.results.slice(0, pageLimit);
  const items = await hydrateTypedResourceRows(env, model, page);
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.results.length > pageLimit && last
      ? encode({ v: 1, modelKey: model.key, signature: sig, sort, key: last.sort_key, id: last.id })
      : null,
  };
}

async function queryViewingWindowCalendarResources(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  params: URLSearchParams,
): Promise<{ items: GenericResource[]; nextCursor: string | null }> {
  const c = model.definition.capabilities?.calendar;
  if (!c) throw new ApiError("CALENDAR_CAPABILITY_NOT_ENABLED", "Calendar capability is required", 400);
  if (LEGACY_WINDOW_PARAMETERS.some((parameter) => params.has(parameter))) {
    throw new ApiError("INVALID_QUERY", "Calendar viewing-window parameters cannot be mixed with legacy range/date window parameters", 400);
  }
  if (!VIEWING_WINDOW_PARAMETERS.every((parameter) => params.has(parameter))) {
    throw new ApiError("INVALID_QUERY", "windowStartDate, windowEndDateExclusive, and viewingTimezone must be provided together", 400);
  }

  const allowed = new Set([
    "q", "status", "windowStartDate", "windowEndDateExclusive", "viewingTimezone", "sort", "limit", "cursor",
    ...(c.attendeePersonField ? [c.attendeePersonField] : []),
  ]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Query parameter ${key} is not supported by Calendar viewing-window query`, 400);
  }

  const windowStartDate = params.get("windowStartDate")!;
  const windowEndDateExclusive = params.get("windowEndDateExclusive")!;
  const viewingTimezone = params.get("viewingTimezone")!;
  let instantRange: { startInclusive: string; endExclusive: string };
  try {
    instantRange = localDateWindowToInstantRange({
      dateStart: windowStartDate,
      dateEndExclusive: windowEndDateExclusive,
      timezone: viewingTimezone,
    });
  } catch (error) {
    throw new ApiError(
      "INVALID_QUERY",
      error instanceof Error ? `Calendar viewing window is invalid: ${error.message}` : "Calendar viewing window is invalid",
      400,
    );
  }

  let attendee = c.attendeePersonField ? params.get(c.attendeePersonField) : null;
  if (attendee === "me") attendee = await mePerson(env, principal, spaceId);
  const sort = semanticSort(params);
  const asc = sort.endsWith(":asc");
  const sig = signature(params);
  const cursor = params.get("cursor") ? decodeViewing(params.get("cursor")!, model.key, sig, sort) : null;
  const pageLimit = limit(params.get("limit"));

  const s = (field: string) => typedScalarExpression(model, field, "m");
  const allDay = s(c.allDayField);
  const startAt = s(c.timedStartField);
  const endAt = s(c.timedEndField);
  const startDate = s(c.allDayStartField);
  const endDate = s(c.allDayEndExclusiveField);
  const scalarSelect = typedSelectColumns(model);

  const base = () => {
    const where = ["r.space_id=?", "r.model_key=?", "r.deleted_at IS NULL"];
    const args: unknown[] = [spaceId, model.key];
    if (params.get("status")) {
      where.push(`${s("status") }=?`);
      args.push(params.get("status"));
    }
    if (attendee && c.attendeePersonField) {
      where.push("EXISTS(SELECT 1 FROM resource_relations rr WHERE rr.source_record_id=r.id AND rr.field_key=? AND rr.target_type='person' AND rr.target_person_id=?)");
      args.push(c.attendeePersonField, attendee);
    }
    const q = params.get("q")?.trim();
    if (q) {
      const fields = model.definition.query?.searchable ?? [];
      if (!fields.length) throw new ApiError("INVALID_QUERY", `Model ${model.key} does not expose searchable fields`, 400);
      where.push(`(${fields.map((field) => `instr(lower(COALESCE(${s(field)},'')),lower(?))>0`).join(" OR ")})`);
      args.push(...fields.map(() => q));
    }
    return { where, args };
  };

  const allDayQuery = base();
  allDayQuery.where.push(`${allDay}=1`, `${startDate}<?`, `${endDate}>?`);
  allDayQuery.args.push(windowEndDateExclusive, windowStartDate);
  if (cursor?.allDay) {
    const op = asc ? ">" : "<";
    allDayQuery.where.push(`(${startDate}${op}? OR (${startDate}=? AND r.id>?))`);
    allDayQuery.args.push(cursor.allDay.start, cursor.allDay.start, cursor.allDay.id);
  }
  allDayQuery.args.push(pageLimit + 1);

  const timedQuery = base();
  timedQuery.where.push(`${allDay}=0`, `${startAt}<?`, `${endAt}>?`);
  timedQuery.args.push(instantRange.endExclusive, instantRange.startInclusive);
  if (cursor?.timed) {
    const op = asc ? ">" : "<";
    timedQuery.where.push(`(${startAt}${op}? OR (${startAt}=? AND r.id>?))`);
    timedQuery.args.push(cursor.timed.start, cursor.timed.start, cursor.timed.id);
  }
  timedQuery.args.push(pageLimit + 1);

  const [allDayRows, timedRows] = await env.DB.batch([
    env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""},${startDate} stream_start
      FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
      WHERE ${allDayQuery.where.join(" AND ")} ORDER BY ${startDate} ${asc ? "ASC" : "DESC"},r.id ASC LIMIT ?`)
      .bind(...allDayQuery.args),
    env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""},${startAt} stream_start
      FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
      WHERE ${timedQuery.where.join(" AND ")} ORDER BY ${startAt} ${asc ? "ASC" : "DESC"},r.id ASC LIMIT ?`)
      .bind(...timedQuery.args),
  ]) as [D1Result<ViewingRow>, D1Result<ViewingRow>];

  const candidates: ViewingCandidate[] = [
    ...allDayRows.results.map((row) => ({ kind: "allDay" as const, localDate: row.stream_start, start: row.stream_start, row })),
    ...timedRows.results.map((row) => ({
      kind: "timed" as const,
      localDate: instantToLocalDate(row.stream_start, viewingTimezone),
      start: row.stream_start,
      row,
    })),
  ].sort((left, right) => viewingCandidateCompare(left, right, asc));

  const pageCandidates = candidates.slice(0, pageLimit);
  const nextState: ViewingCursor = {
    v: 2,
    modelKey: model.key,
    signature: sig,
    sort,
    ...(cursor?.allDay ? { allDay: cursor.allDay } : {}),
    ...(cursor?.timed ? { timed: cursor.timed } : {}),
  };
  for (const candidate of pageCandidates) {
    nextState[candidate.kind] = { start: candidate.start, id: candidate.row.id };
  }

  const items = await hydrateTypedResourceRows(env, model, pageCandidates.map((candidate) => candidate.row));
  return {
    items,
    nextCursor: candidates.length > pageLimit ? encode(nextState) : null,
  };
}

export async function queryCalendarResources(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  params: URLSearchParams,
): Promise<{ items: GenericResource[]; nextCursor: string | null }> {
  const hasViewingWindow = VIEWING_WINDOW_PARAMETERS.some((parameter) => params.has(parameter));
  return hasViewingWindow
    ? queryViewingWindowCalendarResources(env, principal, spaceId, model, params)
    : queryLegacyCalendarResources(env, principal, spaceId, model, params);
}
