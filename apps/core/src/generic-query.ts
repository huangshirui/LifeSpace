import type { Bindings } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import {
  hydrateTypedResourceRows,
  typedScalarExpression,
  typedSelectColumns,
  typedTableSql,
  type TypedResourceRow,
} from "./typed-resource-storage";

type CursorScalar = string | number | null;
type LegacyCursor = {
  v: 1;
  model: string;
  sort: string;
  key: CursorScalar;
  id: string;
  signature: string;
};
type Cursor = {
  v: 2;
  model: string;
  sorts: string[];
  keys: CursorScalar[];
  id: string;
  signature: string;
};
type DecodedCursor = LegacyCursor | Cursor;
type SortCriterion = {
  raw: string;
  field: string;
  direction: "asc" | "desc";
  expression: string;
  nullable: boolean;
};
type QueryRow = TypedResourceRow & Record<string, string | number | null | undefined>;

const MAX_SORT_CRITERIA = 8;

export type GenericQueryResult = {
  items: GenericResource[];
  nextCursor: string | null;
};

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isCursorScalar(value: unknown): value is CursorScalar {
  return value === null || typeof value === "string" || typeof value === "number";
}

function decodeCursor(raw: string): DecodedCursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DecodedCursor>;
    if (value.v === 1) {
      const legacy = value as Partial<LegacyCursor>;
      if (
        typeof legacy.model !== "string"
        || typeof legacy.sort !== "string"
        || !isCursorScalar(legacy.key)
        || typeof legacy.id !== "string"
        || typeof legacy.signature !== "string"
      ) throw new Error("invalid cursor");
      return legacy as LegacyCursor;
    }
    if (value.v === 2) {
      const current = value as Partial<Cursor>;
      if (
        typeof current.model !== "string"
        || !Array.isArray(current.sorts)
        || current.sorts.length < 1
        || current.sorts.some((sort) => typeof sort !== "string")
        || !Array.isArray(current.keys)
        || current.keys.length !== current.sorts.length
        || current.keys.some((key) => !isCursorScalar(key))
        || typeof current.id !== "string"
        || typeof current.signature !== "string"
      ) throw new Error("invalid cursor");
      return current as Cursor;
    }
    throw new Error("invalid cursor");
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function exactDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError("INVALID_QUERY", `${field} must be YYYY-MM-DD`, 400);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_QUERY", `${field} must be a valid date`, 400);
  }
  return value;
}

function dateTime(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !value.includes("T")) throw new ApiError("INVALID_QUERY", `${field} must be an RFC 3339 date-time`, 400);
  return parsed.toISOString();
}

function scalarValue(field: FieldDefinition, raw: string, key: string): string | number {
  switch (field.type) {
    case "string": return raw.trim();
    case "text": return raw;
    case "enum":
      if (!field.values?.includes(raw)) throw new ApiError("INVALID_QUERY", `${key} contains an unsupported enum value`, 400);
      return raw;
    case "date": return exactDate(raw, key);
    case "datetime": return dateTime(raw, key);
    case "timezone":
      try { new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date(0)); } catch { throw new ApiError("INVALID_QUERY", `${key} must be an IANA timezone`, 400); }
      return raw;
    case "integer": {
      const value = Number(raw);
      if (!Number.isInteger(value)) throw new ApiError("INVALID_QUERY", `${key} must be an integer`, 400);
      return value;
    }
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ApiError("INVALID_QUERY", `${key} must be a number`, 400);
      return value;
    }
    case "boolean":
      if (raw !== "true" && raw !== "false") throw new ApiError("INVALID_QUERY", `${key} must be true or false`, 400);
      return raw === "true" ? 1 : 0;
    case "person":
    case "person_list":
    case "record":
    case "record_list":
      if (!raw) throw new ApiError("INVALID_QUERY", `${key} must contain an ID`, 400);
      return raw;
  }
}

function rangeValue(field: FieldDefinition, raw: string, key: string): string | number {
  if (field.type === "date") return exactDate(raw, key);
  if (field.type === "datetime") return dateTime(raw, key);
  if (field.type === "integer" || field.type === "number") return scalarValue(field, raw, key);
  throw new ApiError("INVALID_QUERY", `${key} is not supported for ${field.type}`, 400);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function querySignature(params: URLSearchParams): string {
  const entries = [...params.entries()]
    .filter(([key]) => key !== "cursor" && key !== "limit")
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  return JSON.stringify(entries);
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ApiError("INVALID_QUERY", `${key} may be supplied only once`, 400);
  return values[0] ?? undefined;
}

function parseLimit(params: URLSearchParams): number {
  const raw = one(params, "limit");
  if (raw === undefined) return 100;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new ApiError("INVALID_QUERY", "limit must be an integer between 1 and 200", 400);
  return Number(raw);
}

function allowedQueryKeys(model: PublishedModel): Set<string> {
  const allowed = new Set(["q", "sort", "cursor", "limit"]);
  for (const fieldKey of model.definition.query?.filterable ?? []) {
    allowed.add(fieldKey);
    const field = model.definition.fields[fieldKey];
    if (field && ["date", "datetime", "integer", "number"].includes(field.type)) {
      allowed.add(`${fieldKey}From`);
      allowed.add(`${fieldKey}To`);
    }
  }
  return allowed;
}

function parseSortCriterion(model: PublishedModel, raw: string): SortCriterion {
  const [field, direction, ...rest] = raw.split(":");
  if (rest.length || !field || (direction !== "asc" && direction !== "desc")) throw new ApiError("INVALID_QUERY", "sort must use field:asc or field:desc", 400);
  if (field === "createdAt") return { raw, field, direction, expression: "r.created_at", nullable: false };
  if (field === "updatedAt") return { raw, field, direction, expression: "r.updated_at", nullable: false };
  if (!model.definition.query?.sortable?.includes(field)) throw new ApiError("INVALID_QUERY", `${field} is not a sortable field for model ${model.key}`, 400);
  return {
    raw,
    field,
    direction,
    expression: typedScalarExpression(model, field),
    nullable: model.definition.fields[field]?.nullable === true || model.definition.fields[field]?.required !== true,
  };
}

function parseSorts(model: PublishedModel, params: URLSearchParams): SortCriterion[] {
  const rawSorts = params.getAll("sort");
  const values = rawSorts.length ? rawSorts : ["createdAt:desc"];
  if (values.length > MAX_SORT_CRITERIA) {
    throw new ApiError("INVALID_QUERY", `sort may contain at most ${MAX_SORT_CRITERIA} ordered criteria`, 400);
  }
  const sorts = values.map((raw) => parseSortCriterion(model, raw));
  const seen = new Set<string>();
  for (const sort of sorts) {
    if (seen.has(sort.field)) throw new ApiError("INVALID_QUERY", `sort field ${sort.field} may be supplied only once`, 400);
    seen.add(sort.field);
  }
  return sorts;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cursorPredicate(sorts: SortCriterion[], keys: CursorScalar[], id: string): { sql: string; args: unknown[] } {
  const build = (index: number): { sql: string; args: unknown[] } => {
    if (index >= sorts.length) return { sql: "r.id>?", args: [id] };
    const sort = sorts[index];
    const key = keys[index];
    const rest = build(index + 1);
    if (key === null) {
      if (!sort.nullable) throw new ApiError("INVALID_QUERY", "cursor contains null for a non-nullable sort field", 400);
      return { sql: `(${sort.expression} IS NULL AND ${rest.sql})`, args: rest.args };
    }
    const operator = sort.direction === "asc" ? ">" : "<";
    if (sort.nullable) {
      return {
        sql: `((${sort.expression} IS NULL) OR (${sort.expression} IS NOT NULL AND ${sort.expression}${operator}?) OR (${sort.expression}=? AND ${rest.sql}))`,
        args: [key, key, ...rest.args],
      };
    }
    return {
      sql: `(${sort.expression}${operator}? OR (${sort.expression}=? AND ${rest.sql}))`,
      args: [key, key, ...rest.args],
    };
  };
  return build(0);
}

export async function queryGenericResources(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  params: URLSearchParams,
): Promise<GenericQueryResult> {
  const allowed = allowedQueryKeys(model);
  for (const key of new Set(params.keys())) if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Unsupported query parameter ${key}`, 400);

  const limit = parseLimit(params);
  const sorts = parseSorts(model, params);
  const rawSorts = sorts.map((sort) => sort.raw);
  const signature = querySignature(params);
  const args: unknown[] = [spaceId, model.key];
  const scalarSelect = typedSelectColumns(model);
  const sortSelect = sorts.map((sort, index) => `${sort.expression} AS sort_value_${index}`).join(",");
  let sql = `SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""},${sortSelect}
    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL`;

  const q = one(params, "q");
  if (q !== undefined) {
    const normalized = q.trim();
    if (!normalized || normalized.length > 100) throw new ApiError("INVALID_QUERY", "q must contain 1-100 characters", 400);
    const searchable = model.definition.query?.searchable ?? [];
    if (!searchable.length) throw new ApiError("INVALID_QUERY", `Model ${model.key} does not expose searchable fields`, 400);
    const clauses: string[] = [];
    for (const fieldKey of searchable) {
      const field = model.definition.fields[fieldKey];
      if (!field || !["string", "text", "enum"].includes(field.type)) continue;
      clauses.push(`lower(CAST(${typedScalarExpression(model, fieldKey)} AS TEXT)) LIKE lower(?) ESCAPE '\\'`);
      args.push(`%${escapeLike(normalized)}%`);
    }
    if (!clauses.length) throw new ApiError("INVALID_QUERY", `Model ${model.key} has no text-searchable fields`, 400);
    sql += ` AND (${clauses.join(" OR ")})`;
  }

  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field) continue;
    const exact = one(params, fieldKey);
    if (exact !== undefined) {
      if (field.type === "person" || field.type === "person_list") {
        sql += ` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='person' AND rel.target_person_id=?)`;
        args.push(fieldKey, scalarValue(field, exact, fieldKey));
      } else if (field.type === "record" || field.type === "record_list") {
        sql += ` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='record' AND rel.target_record_id=?)`;
        args.push(fieldKey, scalarValue(field, exact, fieldKey));
      } else if (field.type === "enum" && exact.includes(",")) {
        const values = exact.split(",").filter(Boolean);
        if (!values.length || new Set(values).size !== values.length) throw new ApiError("INVALID_QUERY", `${fieldKey} enum filter is invalid`, 400);
        const parsed = values.map((value) => scalarValue(field, value, fieldKey));
        sql += ` AND ${typedScalarExpression(model, fieldKey)} IN (${parsed.map(() => "?").join(",")})`;
        args.push(...parsed);
      } else {
        sql += ` AND ${typedScalarExpression(model, fieldKey)}=?`;
        args.push(scalarValue(field, exact, fieldKey));
      }
    }

    const from = one(params, `${fieldKey}From`);
    const to = one(params, `${fieldKey}To`);
    if (from !== undefined) {
      if (["person", "person_list", "record", "record_list"].includes(field.type)) throw new ApiError("INVALID_QUERY", `${fieldKey}From is not supported for relation fields`, 400);
      sql += ` AND ${typedScalarExpression(model, fieldKey)}>=?`;
      args.push(rangeValue(field, from, `${fieldKey}From`));
    }
    if (to !== undefined) {
      if (["person", "person_list", "record", "record_list"].includes(field.type)) throw new ApiError("INVALID_QUERY", `${fieldKey}To is not supported for relation fields`, 400);
      sql += ` AND ${typedScalarExpression(model, fieldKey)}<=?`;
      args.push(rangeValue(field, to, `${fieldKey}To`));
    }
  }

  const rawCursor = one(params, "cursor");
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    const cursorSorts = cursor.v === 1 ? [cursor.sort] : cursor.sorts;
    const cursorKeys = cursor.v === 1 ? [cursor.key] : cursor.keys;
    if (
      cursor.model !== model.key
      || !sameStrings(cursorSorts, rawSorts)
      || cursorKeys.length !== sorts.length
      || cursor.signature !== signature
    ) throw new ApiError("INVALID_QUERY", "cursor does not match this model/query", 400);
    const predicate = cursorPredicate(sorts, cursorKeys, cursor.id);
    sql += ` AND ${predicate.sql}`;
    args.push(...predicate.args);
  }

  const order = sorts.flatMap((sort) => [
    ...(sort.nullable ? [`${sort.expression} IS NULL ASC`] : []),
    `${sort.expression} ${sort.direction.toUpperCase()}`,
  ]);
  order.push("r.id ASC");
  sql += ` ORDER BY ${order.join(",")}`;
  sql += " LIMIT ?";
  args.push(limit + 1);

  const rows = await env.DB.prepare(sql).bind(...args).all<QueryRow>();
  const page = rows.results.slice(0, limit);
  const items = await hydrateTypedResourceRows(env, model, page);
  const last = page.at(-1);
  const nextCursor = rows.results.length > limit && last
    ? encodeCursor({
        v: 2,
        model: model.key,
        sorts: rawSorts,
        keys: sorts.map((_sort, index) => last[`sort_value_${index}`] ?? null),
        id: last.id,
        signature,
      })
    : null;
  return { items, nextCursor };
}
