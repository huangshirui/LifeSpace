import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import { addDateDays, computeDayRecord, daysBetween, spaceToday, type DayAttentionLevel, type DayRecordKind } from "./day-calculation";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type DayRecordStatus = "active" | "archived";
type DayRecordSort = "attention" | "date_asc" | "date_desc" | "created_desc" | "updated_desc";
type SpaceRow = { id: string; timezone: string };
type LegacyFamilyRow = { legacy_family_id: string; space_id: string; timezone: string };
type DayRecordRow = {
  id: string;
  space_id: string;
  name: string;
  description: string | null;
  kind: DayRecordKind;
  anchor_date: string;
  cycle_days: number | null;
  next_due_date: string | null;
  attention_before_days: number | null;
  attention_after_days: number | null;
  subject_person_id: string | null;
  icon: string | null;
  status: DayRecordStatus;
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
type OccurrenceRow = {
  id: string;
  day_record_id: string;
  occurred_on: string;
  note: string | null;
  source: "initial" | "manual";
  recorded_by_type: Principal["type"];
  recorded_by_id: string;
  recorded_by_name_snapshot: string;
  created_at: string;
  interval_days: number | null;
};
type Cursor = {
  v: 1;
  resource: "day-records" | "day-record-occurrences";
  sort: DayRecordSort | "occurred_desc";
  key: string;
  id: string;
  filter: string;
};

const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

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
    throw new ApiError("INVALID_DAY_RECORD_RULE", "Request contains fields that are not valid for this day record kind", 400);
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

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
  return value as number;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError("INVALID_DAY_RECORD_DATE", `${field} must be a valid YYYY-MM-DD date`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_DAY_RECORD_DATE", `${field} must be a valid YYYY-MM-DD date`, 400);
  }
  return value;
}

function nullableInteger(value: unknown, field: string, minimum: number, maximum = 3650): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("INVALID_DAY_RECORD_RULE", `${field} must be null or an integer between ${minimum} and ${maximum}`, 400);
  }
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

function decodeCursor(value: string, resource: Cursor["resource"], sort: Cursor["sort"]): Cursor {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as Partial<Cursor>;
    if (decoded.v !== 1 || decoded.resource !== resource || decoded.sort !== sort || typeof decoded.key !== "string" || typeof decoded.id !== "string" || typeof decoded.filter !== "string") throw new Error();
    return decoded as Cursor;
  } catch {
    throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  }
}

function parseKinds(value: string | undefined): DayRecordKind[] {
  const kinds = value?.split(",") ?? ["elapsed", "countdown", "cycle"];
  if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.some((kind) => !["elapsed", "countdown", "cycle"].includes(kind))) {
    throw new ApiError("INVALID_DAY_RECORD_KIND", "kind is invalid", 400);
  }
  return kinds as DayRecordKind[];
}

function parseStatuses(value: string | undefined): DayRecordStatus[] {
  const statuses = value?.split(",") ?? ["active"];
  if (!statuses.length || new Set(statuses).size !== statuses.length || statuses.some((status) => !["active", "archived"].includes(status))) {
    throw new ApiError("INVALID_DAY_RECORD_RULE", "status is invalid", 400);
  }
  return statuses as DayRecordStatus[];
}

async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {
  const row = await env.DB.prepare("SELECT id,timezone FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId).first<SpaceRow>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return row;
}

async function findFamily(env: Bindings, familyId: string): Promise<LegacyFamilyRow> {
  const row = await env.DB.prepare(`SELECT fm.legacy_family_id,fm.space_id,s.timezone
    FROM legacy_homemew_family_maps fm JOIN spaces s ON s.id=fm.space_id
    WHERE fm.legacy_family_id=? AND s.kind='family' AND s.deleted_at IS NULL`)
    .bind(familyId).first<LegacyFamilyRow>();
  if (!row) throw new ApiError("FAMILY_NOT_FOUND", "Family not found", 404);
  return row;
}

async function findDayRecord(env: Bindings, spaceId: string, id: string): Promise<DayRecordRow> {
  const row = await env.DB.prepare("SELECT * FROM day_records WHERE id=? AND space_id=? AND deleted_at IS NULL")
    .bind(id, spaceId).first<DayRecordRow>();
  if (!row) throw new ApiError("DAY_RECORD_NOT_FOUND", "Day record not found", 404);
  return row;
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

async function requireSubjectPerson(env: Bindings, spaceId: string, value: unknown, field = "subjectPersonId"): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_DAY_RECORD_RULE", `${field} must be a Space Person ID or null`, 400);
  const person = await env.DB.prepare("SELECT id FROM space_people WHERE id=? AND space_id=? AND deleted_at IS NULL")
    .bind(value, spaceId).first<{ id: string }>();
  if (!person) throw new ApiError("INVALID_DAY_RECORD_SUBJECT", "subjectPersonId must be an active Space Person in the day record Space", 400);
  return person.id;
}

async function legacySubjectPerson(env: Bindings, familyId: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_DAY_RECORD_RULE", "subjectUserId must be a user ID or null", 400);
  const row = await env.DB.prepare(`SELECT map.person_id FROM legacy_homemew_membership_maps map
    JOIN space_people p ON p.id=map.person_id AND p.deleted_at IS NULL
    WHERE map.legacy_family_id=? AND map.legacy_user_id=?`)
    .bind(familyId, value).first<{ person_id: string }>();
  if (!row) throw new ApiError("SUBJECT_NOT_FAMILY_MEMBER", "subjectUserId must be an active family member", 400);
  return row.person_id;
}

async function subjectDto(env: Bindings, spaceId: string, personId: string | null, legacyFamilyId?: string) {
  if (!personId) return null;
  const person = await env.DB.prepare("SELECT id,display_name FROM space_people WHERE id=? AND space_id=?")
    .bind(personId, spaceId).first<{ id: string; display_name: string }>();
  if (!person) return null;
  if (!legacyFamilyId) return { personId: person.id, displayName: person.display_name };
  const mapping = await env.DB.prepare(`SELECT legacy_user_id FROM legacy_homemew_membership_maps
    WHERE legacy_family_id=? AND person_id=?`).bind(legacyFamilyId, personId).first<{ legacy_user_id: string }>();
  if (!mapping) return null;
  return { userId: mapping.legacy_user_id, displayName: person.display_name, avatarUrl: null };
}

async function dayRecordDto(env: Bindings, row: DayRecordRow, today: string, legacyFamilyId?: string): Promise<Record<string, unknown>> {
  const legacy = Boolean(legacyFamilyId);
  const common = {
    id: row.id,
    ...(legacy ? { familyId: legacyFamilyId } : { spaceId: row.space_id }),
    name: row.name,
    description: row.description,
    kind: row.kind,
    subject: await subjectDto(env, row.space_id, row.subject_person_id, legacyFamilyId),
    icon: row.icon,
    status: row.status,
    version: row.version,
    createdBy: await actorDto(env, row.created_by_type, row.created_by_id, row.created_by_name_snapshot, legacy),
    updatedBy: await actorDto(env, row.updated_by_type, row.updated_by_id, row.updated_by_name_snapshot, legacy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === "elapsed") {
    return {
      ...common,
      anchorDate: row.anchor_date,
      attentionAfterDays: row.attention_after_days,
      computed: computeDayRecord({ kind: "elapsed", anchorDate: row.anchor_date, attentionAfterDays: row.attention_after_days }, today),
    };
  }
  if (row.kind === "countdown") {
    return {
      ...common,
      anchorDate: row.anchor_date,
      attentionBeforeDays: row.attention_before_days,
      computed: computeDayRecord({ kind: "countdown", anchorDate: row.anchor_date, attentionBeforeDays: row.attention_before_days }, today),
    };
  }
  return {
    ...common,
    anchorDate: row.anchor_date,
    cycleDays: row.cycle_days,
    nextDueDate: row.next_due_date,
    attentionBeforeDays: row.attention_before_days,
    computed: computeDayRecord({
      kind: "cycle",
      anchorDate: row.anchor_date,
      cycleDays: row.cycle_days!,
      nextDueDate: row.next_due_date!,
      attentionBeforeDays: row.attention_before_days,
    }, today),
  };
}

async function occurrenceDto(env: Bindings, row: OccurrenceRow, legacy: boolean) {
  return {
    id: row.id,
    dayRecordId: row.day_record_id,
    occurredOn: row.occurred_on,
    note: row.note,
    source: row.source,
    intervalDays: row.interval_days,
    recordedBy: await actorDto(env, row.recorded_by_type, row.recorded_by_id, row.recorded_by_name_snapshot, legacy),
    createdAt: row.created_at,
  };
}

function effectiveDate(record: Record<string, any>): string {
  return record.kind === "cycle" ? record.nextDueDate : record.anchorDate;
}

function sortKey(record: Record<string, any>, sort: DayRecordSort): string {
  if (sort === "attention") {
    const rank: Record<DayAttentionLevel, string> = { critical: "0", warning: "1", info: "2", none: "3" };
    const attentionDate = record.kind === "elapsed" && record.attentionAfterDays !== null
      ? addDateDays(record.anchorDate, record.attentionAfterDays)
      : effectiveDate(record);
    return `${rank[record.computed.attentionLevel as DayAttentionLevel]}|${attentionDate}`;
  }
  if (sort === "date_asc" || sort === "date_desc") return effectiveDate(record);
  if (sort === "created_desc") return record.createdAt;
  return record.updatedAt;
}

function compareTuple(aKey: string, aId: string, bKey: string, bId: string, descending: boolean): number {
  const key = aKey.localeCompare(bKey);
  const id = aId.localeCompare(bId);
  return descending ? -(key || id) : key || id;
}

async function createDayRecord(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const input = await body(context);
  if (typeof input.kind !== "string" || !["elapsed", "countdown", "cycle"].includes(input.kind)) {
    throw new ApiError("INVALID_DAY_RECORD_KIND", "kind must be elapsed, countdown, or cycle", 400);
  }
  const kind = input.kind as DayRecordKind;
  const subjectField = legacyFamilyId ? "subjectUserId" : "subjectPersonId";
  const commonFields = ["name", "description", "kind", "anchorDate", subjectField, "icon"];
  fields(input, kind === "elapsed"
    ? [...commonFields, "attentionAfterDays"]
    : kind === "countdown"
      ? [...commonFields, "attentionBeforeDays"]
      : [...commonFields, "cycleDays", "attentionBeforeDays"]);
  const name = text(input.name, "name", 100);
  const description = optionalText(input.description, "description", 5000) ?? null;
  const icon = optionalText(input.icon, "icon", 50) ?? null;
  const anchorDate = exactDate(input.anchorDate, "anchorDate");
  const subjectPersonId = legacyFamilyId
    ? await legacySubjectPerson(context.env, legacyFamilyId, input[subjectField])
    : await requireSubjectPerson(context.env, space.id, input[subjectField]);
  const today = spaceToday(space.timezone);
  if (kind !== "countdown" && anchorDate > today) throw new ApiError("INVALID_DAY_RECORD_DATE", "anchorDate cannot be later than the Space current date", 400);

  let cycleDays: number | null = null;
  let nextDueDate: string | null = null;
  let attentionBeforeDays: number | null = null;
  let attentionAfterDays: number | null = null;
  if (kind === "elapsed") attentionAfterDays = input.attentionAfterDays === undefined ? null : nullableInteger(input.attentionAfterDays, "attentionAfterDays", 1);
  if (kind === "countdown") attentionBeforeDays = input.attentionBeforeDays === undefined ? 30 : nullableInteger(input.attentionBeforeDays, "attentionBeforeDays", 0);
  if (kind === "cycle") {
    cycleDays = nullableInteger(input.cycleDays, "cycleDays", 1);
    if (cycleDays === null) throw new ApiError("INVALID_DAY_RECORD_RULE", "cycleDays is required", 400);
    nextDueDate = addDateDays(anchorDate, cycleDays);
    attentionBeforeDays = input.attentionBeforeDays === undefined ? 7 : nullableInteger(input.attentionBeforeDays, "attentionBeforeDays", 0);
  }

  const id = createId("day");
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const statements = [context.env.DB.prepare(`INSERT INTO day_records(
    id,space_id,name,description,kind,anchor_date,cycle_days,next_due_date,attention_before_days,attention_after_days,
    subject_person_id,icon,created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,
    created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, space.id, name, description, kind, anchorDate, cycleDays, nextDueDate, attentionBeforeDays, attentionAfterDays,
      subjectPersonId, icon, principal.type, principal.id, actor, principal.type, principal.id, actor, timestamp, timestamp)];
  if (kind !== "countdown") {
    statements.push(context.env.DB.prepare(`INSERT INTO day_record_occurrences(
      id,day_record_id,occurred_on,source,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at)
      VALUES(?,?,?,'initial',?,?,?,?)`).bind(createId("dyo"), id, anchorDate, principal.type, principal.id, actor, timestamp));
  }
  await context.env.DB.batch(statements);
  return context.json(success(await dayRecordDto(context.env, await findDayRecord(context.env, space.id, id), today, legacyFamilyId)), 201);
}

async function updateDayRecord(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const id = context.req.param("dayRecordId")!;
  const previous = await findDayRecord(context.env, space.id, id);
  if (previous.status === "archived") throw new ApiError("DAY_RECORD_ARCHIVED", "Archived day records are read-only", 409);
  const input = await body(context);
  const subjectField = legacyFamilyId ? "subjectUserId" : "subjectPersonId";
  const common = ["name", "description", "icon", subjectField, "version"];
  fields(input, previous.kind === "elapsed"
    ? [...common, "attentionAfterDays"]
    : previous.kind === "countdown"
      ? [...common, "anchorDate", "attentionBeforeDays"]
      : [...common, "cycleDays", "attentionBeforeDays"]);
  if (Object.keys(input).length < 2) throw new ApiError("INVALID_REQUEST", "At least one day record change is required", 400);
  const expected = version(input.version);
  const name = input.name === undefined ? previous.name : text(input.name, "name", 100);
  const description = input.description === undefined ? previous.description : optionalText(input.description, "description", 5000) ?? null;
  const icon = input.icon === undefined ? previous.icon : optionalText(input.icon, "icon", 50) ?? null;
  const subjectPersonId = input[subjectField] === undefined
    ? previous.subject_person_id
    : legacyFamilyId
      ? await legacySubjectPerson(context.env, legacyFamilyId, input[subjectField])
      : await requireSubjectPerson(context.env, space.id, input[subjectField]);
  const anchorDate = input.anchorDate === undefined ? previous.anchor_date : exactDate(input.anchorDate, "anchorDate");
  const cycleDays = input.cycleDays === undefined ? previous.cycle_days : nullableInteger(input.cycleDays, "cycleDays", 1);
  if (previous.kind === "cycle" && cycleDays === null) throw new ApiError("INVALID_DAY_RECORD_RULE", "cycleDays cannot be null", 400);
  const attentionBeforeDays = input.attentionBeforeDays === undefined ? previous.attention_before_days : nullableInteger(input.attentionBeforeDays, "attentionBeforeDays", 0);
  const attentionAfterDays = input.attentionAfterDays === undefined ? previous.attention_after_days : nullableInteger(input.attentionAfterDays, "attentionAfterDays", 1);
  const nextDueDate = previous.kind === "cycle" ? addDateDays(anchorDate, cycleDays!) : null;
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE day_records SET
    name=?,description=?,icon=?,subject_person_id=?,anchor_date=?,cycle_days=?,next_due_date=?,attention_before_days=?,attention_after_days=?,
    updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='active' AND version=?`)
    .bind(name, description, icon, subjectPersonId, anchorDate, cycleDays, nextDueDate, attentionBeforeDays, attentionAfterDays,
      principal.type, principal.id, actor, timestamp, id, space.id, expected).run();
  if (!result.meta.changes) throw new ApiError("DAY_RECORD_VERSION_CONFLICT", "Day record version conflict", 409);
  return context.json(success(await dayRecordDto(context.env, await findDayRecord(context.env, space.id, id), spaceToday(space.timezone), legacyFamilyId)));
}

async function deleteDayRecord(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const id = context.req.param("dayRecordId")!;
  await findDayRecord(context.env, space.id, id);
  const expected = version(Number(context.req.query("version")));
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE day_records SET
    deleted_at=?,deleted_by_type=?,deleted_by_id=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
    .bind(timestamp, principal.type, principal.id, principal.type, principal.id, actor, timestamp, id, space.id, expected).run();
  if (!result.meta.changes) throw new ApiError("DAY_RECORD_VERSION_CONFLICT", "Day record version conflict", 409);
  return context.body(null, 204);
}

async function statusAction(context: Context<AppEnv>, space: SpaceRow, target: DayRecordStatus, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const id = context.req.param("dayRecordId")!;
  const input = await body(context);
  fields(input, ["version"]);
  const previous = await findDayRecord(context.env, space.id, id);
  const expected = version(input.version);
  if (previous.status === target) {
    throw new ApiError(target === "archived" ? "DAY_RECORD_ARCHIVED" : "DAY_RECORD_ALREADY_ACTIVE",
      target === "archived" ? "Day record is already archived" : "Day record is already active", 409);
  }
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE day_records SET status=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
    WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=? AND status=?`)
    .bind(target, principal.type, principal.id, actor, timestamp, id, space.id, expected, previous.status).run();
  if (!result.meta.changes) throw new ApiError("DAY_RECORD_VERSION_CONFLICT", "Day record version conflict", 409);
  return context.json(success(await dayRecordDto(context.env, await findDayRecord(context.env, space.id, id), spaceToday(space.timezone), legacyFamilyId)));
}

async function addOccurrence(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const id = context.req.param("dayRecordId")!;
  const previous = await findDayRecord(context.env, space.id, id);
  if (previous.kind === "countdown") throw new ApiError("OCCURRENCE_NOT_ALLOWED", "Countdown day records do not accept occurrences", 409);
  if (previous.status === "archived") throw new ApiError("DAY_RECORD_ARCHIVED", "Archived day records do not accept occurrences", 409);
  const input = await body(context);
  fields(input, ["occurredOn", "note", "version"]);
  const occurredOn = exactDate(input.occurredOn, "occurredOn");
  const expected = version(input.version);
  const note = optionalText(input.note, "note", 1000) ?? null;
  const today = spaceToday(space.timezone);
  if (occurredOn === previous.anchor_date) throw new ApiError("DUPLICATE_DAY_OCCURRENCE", "An occurrence already exists on this date", 409);
  if (occurredOn < previous.anchor_date || occurredOn > today) {
    throw new ApiError("INVALID_DAY_RECORD_DATE", "occurredOn must be after the current anchorDate and no later than today", 400);
  }
  const mutationToken = crypto.randomUUID();
  const occurrenceId = createId("dyo");
  const nextDueDate = previous.kind === "cycle" ? addDateDays(occurredOn, previous.cycle_days!) : null;
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`UPDATE day_records SET anchor_date=?,next_due_date=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,
      updated_at=?,version=version+1,mutation_token=?
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND status='active' AND version=? AND anchor_date<?`)
      .bind(occurredOn, nextDueDate, principal.type, principal.id, actor, timestamp, mutationToken, id, space.id, expected, occurredOn),
    context.env.DB.prepare(`INSERT INTO day_record_occurrences(
      id,day_record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at)
      SELECT ?,id,?,?,'manual',?,?,?,? FROM day_records WHERE id=? AND mutation_token=?`)
      .bind(occurrenceId, occurredOn, note, principal.type, principal.id, actor, timestamp, id, mutationToken),
    context.env.DB.prepare("UPDATE day_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(id, mutationToken),
  ]);
  if (!results[0].meta.changes) {
    const current = await findDayRecord(context.env, space.id, id);
    if (current.anchor_date === occurredOn) throw new ApiError("DUPLICATE_DAY_OCCURRENCE", "An occurrence already exists on this date", 409);
    if (current.anchor_date > occurredOn) throw new ApiError("INVALID_DAY_RECORD_DATE", "occurredOn must be after the current anchorDate", 400);
    throw new ApiError("DAY_RECORD_VERSION_CONFLICT", "Day record version conflict", 409);
  }
  return context.json(success({
    previousAnchorDate: previous.anchor_date,
    intervalDays: daysBetween(previous.anchor_date, occurredOn),
    record: await dayRecordDto(context.env, await findDayRecord(context.env, space.id, id), today, legacyFamilyId),
  }), 201);
}

async function listOccurrences(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
  const id = context.req.param("dayRecordId")!;
  await findDayRecord(context.env, space.id, id);
  const limit = parseLimit(context.req.query("limit"));
  const filter = JSON.stringify({ dayRecordId: id });
  const cursor = context.req.query("cursor") ? decodeCursor(context.req.query("cursor")!, "day-record-occurrences", "occurred_desc") : undefined;
  if (cursor && cursor.filter !== filter) throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  const rows = await context.env.DB.prepare(`SELECT *,CAST(julianday(occurred_on)-julianday(previous_on) AS INTEGER) interval_days FROM (
    SELECT o.*,LAG(occurred_on) OVER (ORDER BY occurred_on,id) previous_on FROM day_record_occurrences o WHERE day_record_id=?
  ) ORDER BY occurred_on DESC,id DESC`).bind(id).all<OccurrenceRow>();
  const remaining = cursor ? rows.results.filter((row) => compareTuple(row.occurred_on, row.id, cursor.key, cursor.id, true) > 0) : rows.results;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  const last = page.at(-1);
  return context.json(success({
    items: await Promise.all(page.map((row) => occurrenceDto(context.env, row, Boolean(legacyFamilyId)))),
    nextCursor: hasMore && last ? encodeCursor({ v: 1, resource: "day-record-occurrences", sort: "occurred_desc", key: last.occurred_on, id: last.id, filter }) : null,
  }));
}

async function subjectFilter(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<string | undefined> {
  const field = legacyFamilyId ? "subjectUserId" : "subjectPersonId";
  let value = context.req.query(field);
  if (!value) return undefined;
  if (value === "me") {
    const principal = context.get("principal");
    if (principal.type !== "user") throw new ApiError("INVALID_FILTER", "me is available only for users", 400);
    if (legacyFamilyId) {
      const mapping = await context.env.DB.prepare(`SELECT map.person_id FROM legacy_homemew_membership_maps map
        JOIN legacy_homemew_user_maps user_map ON user_map.legacy_user_id=map.legacy_user_id
        JOIN space_people p ON p.id=map.person_id AND p.deleted_at IS NULL
        WHERE map.legacy_family_id=? AND user_map.lifespace_user_id=?`)
        .bind(legacyFamilyId, principal.id).first<{ person_id: string }>();
      if (!mapping) throw new ApiError("SUBJECT_NOT_FAMILY_MEMBER", "Current user is not an active family member", 400);
      return mapping.person_id;
    }
    const person = await context.env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL")
      .bind(space.id, principal.id).first<{ id: string }>();
    if (!person) throw new ApiError("INVALID_DAY_RECORD_SUBJECT", "Current user is not an active Space Person", 400);
    return person.id;
  }
  return legacyFamilyId
    ? (await legacySubjectPerson(context.env, legacyFamilyId, value)) ?? undefined
    : (await requireSubjectPerson(context.env, space.id, value)) ?? undefined;
}

async function listDayRecords(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
  const kinds = parseKinds(context.req.query("kind"));
  const statuses = parseStatuses(context.req.query("status"));
  const attentionOnlyText = context.req.query("attentionOnly");
  if (attentionOnlyText !== undefined && !["true", "false"].includes(attentionOnlyText)) {
    throw new ApiError("INVALID_DAY_RECORD_RULE", "attentionOnly must be true or false", 400);
  }
  const attentionOnly = attentionOnlyText === "true";
  const sort = (context.req.query("sort") ?? "attention") as DayRecordSort;
  if (!["attention", "date_asc", "date_desc", "created_desc", "updated_desc"].includes(sort)) {
    throw new ApiError("INVALID_DAY_RECORD_RULE", "sort is invalid", 400);
  }
  const subjectPersonId = await subjectFilter(context, space, legacyFamilyId);
  const today = spaceToday(space.timezone);
  const filter = JSON.stringify({ kinds, statuses, subjectPersonId: subjectPersonId ?? null, attentionOnly, today });
  const cursor = context.req.query("cursor") ? decodeCursor(context.req.query("cursor")!, "day-records", sort) : undefined;
  if (cursor && cursor.filter !== filter) throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);

  const kindMarks = kinds.map(() => "?").join(",");
  const statusMarks = statuses.map(() => "?").join(",");
  const args: unknown[] = [space.id, ...kinds, ...statuses];
  let sql = `SELECT * FROM day_records WHERE space_id=? AND deleted_at IS NULL AND kind IN (${kindMarks}) AND status IN (${statusMarks})`;
  if (subjectPersonId) { sql += " AND subject_person_id=?"; args.push(subjectPersonId); }
  const rows = await context.env.DB.prepare(sql).bind(...args).all<DayRecordRow>();
  let records = await Promise.all(rows.results.map((row) => dayRecordDto(context.env, row, today, legacyFamilyId))) as Array<Record<string, any>>;
  if (attentionOnly) records = records.filter((record) => record.computed.isAttentionRequired);
  const descending = ["date_desc", "created_desc", "updated_desc"].includes(sort);
  records.sort((a, b) => compareTuple(sortKey(a, sort), a.id, sortKey(b, sort), b.id, descending));
  if (cursor) records = records.filter((record) => compareTuple(sortKey(record, sort), record.id, cursor.key, cursor.id, descending) > 0);
  const limit = parseLimit(context.req.query("limit"));
  const page = records.slice(0, limit);
  const hasMore = records.length > limit;
  const last = page.at(-1);
  return context.json(success({
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ v: 1, resource: "day-records", sort, key: sortKey(last, sort), id: last.id, filter }) : null,
  }));
}

async function readDayRecord(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
  const row = await findDayRecord(context.env, space.id, context.req.param("dayRecordId")!);
  return context.json(success(await dayRecordDto(context.env, row, spaceToday(space.timezone), legacyFamilyId)));
}

export function registerDayRecordRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/day-records", requireScope("day-records:read"), async (context) =>
    listDayRecords(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/day-records", requireScope("day-records:write"), async (context) =>
    createDayRecord(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.get("/api/v1/spaces/:spaceId/day-records/:dayRecordId", requireScope("day-records:read"), async (context) =>
    readDayRecord(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.patch("/api/v1/spaces/:spaceId/day-records/:dayRecordId", requireScope("day-records:write"), async (context) =>
    updateDayRecord(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.delete("/api/v1/spaces/:spaceId/day-records/:dayRecordId", requireScope("day-records:write"), async (context) =>
    deleteDayRecord(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/day-records/:dayRecordId/archive", requireScope("day-records:write"), async (context) =>
    statusAction(context, await findSpace(context.env, context.req.param("spaceId")), "archived"));
  app.post("/api/v1/spaces/:spaceId/day-records/:dayRecordId/restore", requireScope("day-records:write"), async (context) =>
    statusAction(context, await findSpace(context.env, context.req.param("spaceId")), "active"));
  app.get("/api/v1/spaces/:spaceId/day-records/:dayRecordId/occurrences", requireScope("day-records:read"), async (context) =>
    listOccurrences(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/day-records/:dayRecordId/occurrences", requireScope("day-records:write"), async (context) =>
    addOccurrence(context, await findSpace(context.env, context.req.param("spaceId"))));

  app.get("/api/v1/families/:familyId/day-records", requireScope("day-records:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return listDayRecords(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/day-records", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return createDayRecord(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
  app.get("/api/v1/families/:familyId/day-records/:dayRecordId", requireScope("day-records:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return readDayRecord(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
  app.patch("/api/v1/families/:familyId/day-records/:dayRecordId", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return updateDayRecord(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
  app.delete("/api/v1/families/:familyId/day-records/:dayRecordId", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return deleteDayRecord(context, { id: family.space_id, timezone: family.timezone });
  });
  app.post("/api/v1/families/:familyId/day-records/:dayRecordId/archive", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return statusAction(context, { id: family.space_id, timezone: family.timezone }, "archived", family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/day-records/:dayRecordId/restore", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return statusAction(context, { id: family.space_id, timezone: family.timezone }, "active", family.legacy_family_id);
  });
  app.get("/api/v1/families/:familyId/day-records/:dayRecordId/occurrences", requireScope("day-records:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return listOccurrences(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/day-records/:dayRecordId/occurrences", requireScope("day-records:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return addOccurrence(context, { id: family.space_id, timezone: family.timezone }, family.legacy_family_id);
  });
}
