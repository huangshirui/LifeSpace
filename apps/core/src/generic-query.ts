import type { CanonicalFilter, CanonicalQueryInput } from "./canonical-query";
import type { Bindings } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import {
  genericComparisonFieldSemantics,
  isGenericComparableFieldType,
  type GenericComparisonOperator,
  type GenericComparisonValueType,
  type GenericComparisonFieldSemantic,
} from "./query-semantics";
import { assertIanaTimezone, localDateWindowToInstantRange, normalizeRfc3339Instant } from "./time-semantics";
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
  try {
    return normalizeRfc3339Instant(value);
  } catch {
    throw new ApiError("INVALID_QUERY", `${field} must be an absolute RFC 3339 date-time`, 400);
  }
}

function scalarValue(field: FieldDefinition, raw: string, key: string): string | number {
  switch (field.type) {
    case "recurrence_rule":
    case "entity_ref": throw new ApiError("INVALID_QUERY", "Structured field is not a scalar comparison", 400);
    case "string": return raw.trim();
    case "text": return raw;
    case "enum":
      if (!field.values?.includes(raw)) throw new ApiError("INVALID_QUERY", `${key} contains an unsupported enum value`, 400);
      return raw;
    case "date": return exactDate(raw, key);
    case "instant":
    case "datetime": return dateTime(raw, key);
    case "timezone":
      try { return assertIanaTimezone(raw); } catch { throw new ApiError("INVALID_QUERY", `${key} must be an IANA timezone`, 400); }
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
    case "enum_list":
    case "file_ref_list":
    case "range<date>":
    case "range<instant>":
    case "temporal_range":
      throw new ApiError("INVALID_QUERY", `${key} requires the structured Canonical Query transport`, 400);
  }
}

function comparisonValue(type: GenericComparisonValueType, raw: string, key: string): string | number {
  if (type === "date") return exactDate(raw, key);
  if (type === "instant" || type === "datetime") return dateTime(raw, key);
  if (type === "integer") {
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new ApiError("INVALID_QUERY", key + " must be an integer", 400);
    return value;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ApiError("INVALID_QUERY", key + " must be a number", 400);
  return value;
}

function comparisonExpression(model: PublishedModel, semantic: GenericComparisonFieldSemantic): string {
  if (semantic.source === "envelope") {
    return semantic.field === "createdAt" ? "r.created_at" : "r.updated_at";
  }
  return typedScalarExpression(model, semantic.field);
}

function comparisonSqlOperator(operator: GenericComparisonOperator): string {
  switch (operator) {
    case "eq": return "=";
    case "lt": return "<";
    case "lte": return "<=";
    case "gt": return ">";
    case "gte": return ">=";
  }
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
  for (const fieldKey of model.definition.query?.filterable ?? []) allowed.add(fieldKey);
  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    for (const transport of semantic.operators) allowed.add(transport.parameter);
    if (semantic.localDateWindow) {
      allowed.add(semantic.localDateWindow.dateStartParameter);
      allowed.add(semantic.localDateWindow.dateEndExclusiveParameter);
      allowed.add(semantic.localDateWindow.timezoneParameter);
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

function canonicalExactValue(field: FieldDefinition, raw: string, key: string): string | number | boolean {
  if (field.type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new ApiError("INVALID_QUERY", `${key} must be true or false`, 400);
    return raw === "true";
  }
  return scalarValue(field, raw, key);
}

function decodeCursorVersion(raw: string): number | null {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown };
    return typeof value.v === "number" ? value.v : null;
  } catch {
    return null;
  }
}

/**
 * Keeps already-issued Generic GET cursors usable during the Canonical Query migration.
 * New GET requests emit Canonical Query v3 cursors and stay on the canonical planner.
 */
export function hasLegacyGenericCursor(params: URLSearchParams): boolean {
  const cursors = params.getAll("cursor");
  return cursors.length === 1 && Boolean(cursors[0]) && [1, 2].includes(decodeCursorVersion(cursors[0]) ?? -1);
}

/**
 * Deterministically lowers the legacy Generic GET transport to Canonical Query.
 * Calendar/Temporal special transports are selected before this function and retain
 * their compatibility planners until their computed ordering is canonicalized.
 */
export function translateGenericGetQuery(
  model: PublishedModel,
  params: URLSearchParams,
): CanonicalQueryInput {
  const allowed = allowedQueryKeys(model);
  for (const key of new Set(params.keys())) {
    if (!allowed.has(key)) throw new ApiError("INVALID_QUERY", `Unsupported query parameter ${key}`, 400);
  }

  const predicates: CanonicalFilter[] = [];
  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    const suppliedOperators = new Map<GenericComparisonOperator, string>();
    for (const transport of semantic.operators) {
      const raw = one(params, transport.parameter);
      if (raw === undefined) continue;
      const previous = suppliedOperators.get(transport.operator);
      if (previous) {
        throw new ApiError(
          "INVALID_QUERY",
          previous + " and " + transport.parameter + " are aliases for the same " + transport.operator + " operator",
          400,
        );
      }
      suppliedOperators.set(transport.operator, transport.parameter);
      predicates.push({
        field: semantic.field,
        op: transport.operator,
        value: comparisonValue(semantic.valueType, raw, transport.parameter),
      });
    }

    const window = semantic.localDateWindow;
    if (window) {
      const dateStart = one(params, window.dateStartParameter);
      const dateEndExclusive = one(params, window.dateEndExclusiveParameter);
      const timezone = one(params, window.timezoneParameter);
      const suppliedCount = [dateStart, dateEndExclusive, timezone].filter((value) => value !== undefined).length;
      if (suppliedCount > 0 && suppliedCount < 3) {
        throw new ApiError(
          "INVALID_QUERY",
          semantic.field + " local-date window requires dateStart, dateEndExclusive, and timezone together",
          400,
        );
      }
      if (suppliedCount === 3) {
        try {
          localDateWindowToInstantRange({ dateStart: dateStart!, dateEndExclusive: dateEndExclusive!, timezone: timezone! });
        } catch (error) {
          throw new ApiError(
            "INVALID_QUERY",
            error instanceof Error
              ? semantic.field + " local-date window is invalid: " + error.message
              : semantic.field + " local-date window is invalid",
            400,
          );
        }
        predicates.push({
          field: semantic.field,
          op: "within",
          value: { kind: "local_date_window", startDate: dateStart!, endDateExclusive: dateEndExclusive!, timezone: timezone! },
        });
      }
    }
  }

  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field || isGenericComparableFieldType(field.type)) continue;
    const exact = one(params, fieldKey);
    if (exact === undefined) continue;
    if (field.type === "person" || field.type === "person_list" || field.type === "record" || field.type === "record_list") {
      predicates.push({ field: fieldKey, op: "contains", value: exact });
    } else if (field.type === "enum" && exact.includes(",")) {
      const values = exact.split(",").filter(Boolean);
      if (!values.length || new Set(values).size !== values.length) {
        throw new ApiError("INVALID_QUERY", fieldKey + " enum filter is invalid", 400);
      }
      predicates.push({
        or: values.map((value) => ({
          field: fieldKey,
          op: "eq",
          value: canonicalExactValue(field, value, fieldKey),
        })),
      });
    } else {
      predicates.push({ field: fieldKey, op: "eq", value: canonicalExactValue(field, exact, fieldKey) });
    }
  }

  const q = one(params, "q");
  let search: CanonicalQueryInput["search"];
  if (q !== undefined) {
    const text = q.trim();
    if (!text || text.length > 100) throw new ApiError("INVALID_QUERY", "q must contain 1-100 characters", 400);
    if (!(model.definition.query?.searchable?.length)) {
      throw new ApiError("INVALID_QUERY", `Model ${model.key} does not expose searchable fields`, 400);
    }
    search = { text };
  }

  const sorts = parseSorts(model, params).map(({ field, direction }) => ({ field, direction }));
  const cursor = one(params, "cursor") ?? null;
  return {
    ...(search ? { search } : {}),
    ...(predicates.length === 1 ? { filter: predicates[0] } : predicates.length ? { filter: { and: predicates } } : {}),
    sort: sorts,
    page: { limit: parseLimit(params), cursor: cursor || null },
  };
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

  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    const expression = comparisonExpression(model, semantic);
    const suppliedOperators = new Map<GenericComparisonOperator, string>();
    for (const transport of semantic.operators) {
      const raw = one(params, transport.parameter);
      if (raw === undefined) continue;
      const previous = suppliedOperators.get(transport.operator);
      if (previous) {
        throw new ApiError(
          "INVALID_QUERY",
          previous + " and " + transport.parameter + " are aliases for the same " + transport.operator + " operator",
          400,
        );
      }
      suppliedOperators.set(transport.operator, transport.parameter);
      sql += " AND " + expression + comparisonSqlOperator(transport.operator) + "?";
      args.push(comparisonValue(semantic.valueType, raw, transport.parameter));
    }

    const window = semantic.localDateWindow;
    if (window) {
      const dateStart = one(params, window.dateStartParameter);
      const dateEndExclusive = one(params, window.dateEndExclusiveParameter);
      const timezone = one(params, window.timezoneParameter);
      const suppliedCount = [dateStart, dateEndExclusive, timezone].filter((value) => value !== undefined).length;
      if (suppliedCount > 0 && suppliedCount < 3) {
        throw new ApiError(
          "INVALID_QUERY",
          semantic.field + " local-date window requires dateStart, dateEndExclusive, and timezone together",
          400,
        );
      }
      if (suppliedCount === 3) {
        try {
          const instantRange = localDateWindowToInstantRange({
            dateStart: dateStart!,
            dateEndExclusive: dateEndExclusive!,
            timezone: timezone!,
          });
          sql += " AND " + expression + ">=? AND " + expression + "<?";
          args.push(instantRange.startInclusive, instantRange.endExclusive);
        } catch (error) {
          throw new ApiError(
            "INVALID_QUERY",
            error instanceof Error
              ? semantic.field + " local-date window is invalid: " + error.message
              : semantic.field + " local-date window is invalid",
            400,
          );
        }
      }
    }
  }

  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field || isGenericComparableFieldType(field.type)) continue;
    const exact = one(params, fieldKey);
    if (exact === undefined) continue;
    if (field.type === "person" || field.type === "person_list") {
      sql += ` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='person' AND rel.target_person_id=?)`;
      args.push(fieldKey, scalarValue(field, exact, fieldKey));
    } else if (field.type === "record" || field.type === "record_list") {
      sql += ` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='record' AND rel.target_record_id=?)`;
      args.push(fieldKey, scalarValue(field, exact, fieldKey));
    } else if (field.type === "enum" && exact.includes(",")) {
      const values = exact.split(",").filter(Boolean);
      if (!values.length || new Set(values).size !== values.length) throw new ApiError("INVALID_QUERY", fieldKey + " enum filter is invalid", 400);
      const parsed = values.map((value) => scalarValue(field, value, fieldKey));
      sql += " AND " + typedScalarExpression(model, fieldKey) + " IN (" + parsed.map(() => "?").join(",") + ")";
      args.push(...parsed);
    } else {
      sql += " AND " + typedScalarExpression(model, fieldKey) + "=?";
      args.push(scalarValue(field, exact, fieldKey));
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