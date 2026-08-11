import type { Bindings, Principal } from "./env";
import { getGenericResource, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { spaceToday } from "./day-calculation";
import { loadSpaceTemporalContext } from "./temporal-capability";

type Cursor = { v: 1; modelKey: string; signature: string; sort: string; key: string | number; id: string };
type Row = { id: string; sort_key: string | number };

function encode(value: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(raw: string, modelKey: string, signature: string, sort: string): Cursor {
  try {
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Cursor;
    if (value.v !== 1 || value.modelKey !== modelKey || value.signature !== signature || value.sort !== sort || typeof value.id !== "string") throw new Error();
    return value;
  } catch { throw new ApiError("INVALID_QUERY", "cursor is invalid for this Temporal query", 400); }
}
function querySignature(params: URLSearchParams) {
  return JSON.stringify([...params.entries()].filter(([key]) => key !== "cursor" && key !== "limit").sort());
}
function parseLimit(raw: string | null) {
  if (raw === null) return 100;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
  return Number(raw);
}
async function mePerson(env: Bindings, principal: Principal, spaceId: string) {
  if (principal.type !== "user") throw new ApiError("INVALID_QUERY", "me requires a user principal", 400);
  const row = await env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1")
    .bind(spaceId, principal.id).first<{ id: string }>();
  if (!row) throw new ApiError("INVALID_QUERY", "me requires an active Space Person", 400);
  return row.id;
}

export function isTemporalSpecialQuery(model: PublishedModel, params: URLSearchParams) {
  if (!model.definition.capabilities?.temporal) return false;
  const sort = params.get("sort");
  return params.has("attentionOnly") || params.get(model.definition.capabilities.temporal.subjectPersonField ?? "") === "me"
    || sort === "attention:desc" || sort === "effectiveDate:asc" || sort === "effectiveDate:desc";
}

export async function queryTemporalResources(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, params: URLSearchParams): Promise<{ items: GenericResource[]; nextCursor: string | null }> {
  const t = model.definition.capabilities?.temporal;
  if (!t) throw new ApiError("TEMPORAL_CAPABILITY_NOT_ENABLED", "Temporal capability is required", 400);
  const allowed = new Set(["q", "kind", "status", "anchorDateFrom", "anchorDateTo", "attentionOnly", "sort", "limit", "cursor", ...(t.subjectPersonField ? [t.subjectPersonField] : [])]);
  for (const key of params.keys()) if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Query parameter ${key} is not supported by Temporal query`, 400);
  const sort = params.get("sort") ?? "effectiveDate:asc";
  if (!["attention:desc", "effectiveDate:asc", "effectiveDate:desc"].includes(sort)) throw new ApiError("INVALID_QUERY", "Unsupported Temporal sort", 400);
  const attentionOnly = params.get("attentionOnly") === "true";
  if (params.has("attentionOnly") && !["true", "false"].includes(params.get("attentionOnly")!)) throw new ApiError("INVALID_QUERY", "attentionOnly must be true or false", 400);
  let subject = t.subjectPersonField ? params.get(t.subjectPersonField) : null;
  if (subject === "me") subject = await mePerson(env, principal, spaceId);
  const space = await loadSpaceTemporalContext(env, spaceId);
  const today = spaceToday(space.timezone);
  const j = (field: string) => `json_extract(r.data_json,'$.${field}')`;
  const kind = j(t.kindField), anchor = j(t.anchorDateField), cycle = j(t.cycleDaysField), before = j(t.attentionBeforeDaysField), after = j(t.attentionAfterDaysField), status = j(t.statusField);
  const effective = `CASE WHEN ${kind}='cycle' THEN date(${anchor},'+'||CAST(${cycle} AS TEXT)||' days') ELSE ${anchor} END`;
  const attention = `CASE WHEN ${status}!='active' THEN -1000000000 WHEN ${kind}='elapsed' AND ${after} IS NOT NULL AND julianday(c.today)-julianday(${anchor})>=${after} THEN CAST(julianday(c.today)-julianday(${anchor})-${after} AS INTEGER) WHEN ${kind}='countdown' AND ${before} IS NOT NULL AND julianday(${anchor})-julianday(c.today)<=${before} THEN CAST(${before}-(julianday(${anchor})-julianday(c.today)) AS INTEGER) WHEN ${kind}='cycle' AND ${before} IS NOT NULL AND julianday(${effective})-julianday(c.today)<=${before} THEN CAST(${before}-(julianday(${effective})-julianday(c.today)) AS INTEGER) ELSE -1000000000 END`;
  const where = ["r.space_id=?", "r.model_key=?", "r.deleted_at IS NULL"];
  const args: unknown[] = [today, spaceId, model.key];
  if (params.get("kind")) { where.push(`${kind}=?`); args.push(params.get("kind")); }
  if (params.get("status")) { where.push(`${status}=?`); args.push(params.get("status")); }
  if (subject && t.subjectPersonField) { where.push(`${j(t.subjectPersonField)}=?`); args.push(subject); }
  if (params.get("anchorDateFrom")) { where.push(`${anchor}>=?`); args.push(params.get("anchorDateFrom")); }
  if (params.get("anchorDateTo")) { where.push(`${anchor}<=?`); args.push(params.get("anchorDateTo")); }
  if (attentionOnly) where.push(`${attention}>-1000000000`);
  const q = params.get("q")?.trim();
  if (q) {
    const fields = model.definition.query?.searchable ?? [];
    where.push(`(${fields.map((field) => `instr(lower(COALESCE(${j(field)},'')),lower(?))>0`).join(" OR ")})`);
    args.push(...fields.map(() => q));
  }
  const signature = querySignature(params);
  const cursor = params.get("cursor") ? decode(params.get("cursor")!, model.key, signature, sort) : null;
  const sortColumn = sort === "attention:desc" ? "attention_score" : "effective_date";
  const asc = sort === "effectiveDate:asc";
  let cursorWhere = "";
  if (cursor) {
    const op = asc ? ">" : "<";
    cursorWhere = `WHERE ${sortColumn}${op}? OR (${sortColumn}=? AND id${op}?)`;
    args.push(cursor.key, cursor.key, cursor.id);
  }
  const limit = parseLimit(params.get("limit")); args.push(limit + 1);
  const order = sort === "attention:desc" ? "attention_score DESC,id DESC" : `effective_date ${asc ? "ASC" : "DESC"},id ${asc ? "ASC" : "DESC"}`;
  const rows = await env.DB.prepare(`WITH constants(today) AS (VALUES (?)), scoped AS (SELECT r.id,${effective} effective_date,${attention} attention_score FROM resource_records r CROSS JOIN constants c WHERE ${where.join(" AND ")}) SELECT id,${sortColumn} sort_key FROM scoped ${cursorWhere} ORDER BY ${order} LIMIT ?`)
    .bind(...args).all<Row>();
  const page = rows.results.slice(0, limit);
  const items = (await Promise.all(page.map((row) => getGenericResource(env, spaceId, model.key, row.id)))).filter((item): item is GenericResource => Boolean(item));
  const last = page.at(-1);
  return { items, nextCursor: rows.results.length > limit && last ? encode({ v: 1, modelKey: model.key, signature, sort, key: last.sort_key, id: last.id }) : null };
}
