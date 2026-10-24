import { canonicalQuerySemanticDescriptor } from "./canonical-query-contract";
import type { Bindings, Principal } from "./env";
import { normalizeCanonicalFieldValue, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import { isFirstClassRangeFieldType, rangeFieldValueType, type FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import { projectTimeRangeSemantics, type TimeRangeBounds } from "./time-range-definition";
import { assertIanaTimezone, localDateWindowToInstantRange, normalizeRfc3339Instant } from "./time-semantics";
import {
  hydrateTypedResourceRows,
  resourceAuditJoins,
  resourceAuditSelectColumns,
  typedLocationExpressions,
  typedRangeExpressions,
  typedScalarExpression,
  typedSelectColumns,
  typedTemporalRangeExpressions,
  typedTableSql,
  type TypedResourceRow,
} from "./typed-resource-storage";

type JsonObject = Record<string, unknown>;
type CursorScalar = string | number | null;
type Direction = "asc" | "desc";
type ViewingContext = { viewingTimezone: string };
type TemporalVariant = "date" | "instant" | "null";
type ScalarOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "isNull" | "isNotNull" | "within";
type RelationOperator = "contains";
type RangeOperator = "overlaps" | "contains" | "before" | "after";
type TemporalRangeOperator = RangeOperator | "kindIs";
type CanonicalOperator = ScalarOperator | RelationOperator | RangeOperator | TemporalRangeOperator | "withinDistance";

type LocalDateWindow = {
  kind: "local_date_window";
  startDate: string;
  endDateExclusive: string;
  timezone: string;
};

type DateRangeOperand = {
  kind: "date";
  start: string;
  endExclusive: string;
};

type InstantRangeOperand = {
  kind: "instant";
  start: string;
  endExclusive: string;
};

type RangeOperand = LocalDateWindow | DateRangeOperand | InstantRangeOperand;

type FilterPredicate = {
  field: string;
  op: CanonicalOperator;
  value?: unknown;
};

export type CanonicalFilter =
  | FilterPredicate
  | { and: CanonicalFilter[] }
  | { or: CanonicalFilter[] };

export type CanonicalQueryInput = {
  search?: { text: string };
  filter?: CanonicalFilter;
  sort?: Array<{ field: string; direction: Direction }>;
  context?: ViewingContext;
  page?: { limit?: number; cursor?: string | null };
};

export type CanonicalQueryResult = {
  items: GenericResource[];
  nextCursor: string | null;
};

type SortCriterion = {
  raw: string;
  field: string;
  direction: Direction;
  expression: string;
  nullable: boolean;
  temporal?: {
    kind: string;
    start: string;
    end: string;
    viewingTimezone: string;
  };
};

type QueryRow = TypedResourceRow & Record<string, string | number | null | undefined>;

type Cursor = {
  v: 3;
  model: string;
  signature: string;
  sorts: string[];
  keys: CursorScalar[];
  id: string;
};

type TemporalStreamCursor = { keys: CursorScalar[]; id: string };
type TemporalCursor = {
  v: 4;
  model: string;
  signature: string;
  sorts: string[];
  streams: Partial<Record<TemporalVariant, TemporalStreamCursor>>;
};

type SqlFragment = { sql: string; args: unknown[] };
type QueryRange = { kind: "date" | "instant"; start: string; endExclusive: string };

type NormalizedQuery = {
  search?: { text: string };
  filter?: CanonicalFilter;
  sort: Array<{ field: string; direction: Direction }>;
  context?: ViewingContext;
};

const MAX_SORT_CRITERIA = 8;
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES = 100;
const MAX_QUERY_BINDINGS = 100;
const FILTER_OPERATORS = new Set<CanonicalOperator>([
  "eq", "ne", "lt", "lte", "gt", "gte", "isNull", "isNotNull", "within",
  "contains", "overlaps", "before", "after", "kindIs", "withinDistance",
]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizeFilter(filter: CanonicalFilter): CanonicalFilter {
  if ("and" in filter) {
    const children = filter.and.map(normalizeFilter).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return { and: children };
  }
  if ("or" in filter) {
    const children = filter.or.map(normalizeFilter).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return { or: children };
  }
  return stableValue(filter) as FilterPredicate;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ApiError("INVALID_QUERY", `${field} must be YYYY-MM-DD`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_QUERY", `${field} must be a valid date`, 400);
  }
  return value;
}

function instant(value: unknown, field: string): string {
  try {
    return normalizeRfc3339Instant(value);
  } catch {
    throw new ApiError("INVALID_QUERY", `${field} must be an absolute RFC 3339 date-time`, 400);
  }
}

function scalarValue(field: FieldDefinition, raw: unknown, path: string): string | number {
  switch (field.type) {
    case "recurrence_rule":
    case "entity_ref":
    case "enum_list":
    case "file":
    case "file_list":
    case "file_ref_list":
      throw new ApiError("INVALID_QUERY", "Structured field is not a scalar comparison", 400);
    case "string":
      if (typeof raw !== "string") throw new ApiError("INVALID_QUERY", `${path} must be a string`, 400);
      return raw.trim();
    case "text":
      if (typeof raw !== "string") throw new ApiError("INVALID_QUERY", `${path} must be a string`, 400);
      return raw;
    case "enum":
      if (typeof raw !== "string" || !field.values?.includes(raw)) throw new ApiError("INVALID_QUERY", `${path} is not a declared enum value`, 400);
      return raw;
    case "date": return exactDate(raw, path);
    case "instant":
    case "datetime": return instant(raw, path);
    case "timezone": {
      if (typeof raw !== "string") throw new ApiError("INVALID_QUERY", `${path} must be an IANA timezone`, 400);
      try { return assertIanaTimezone(raw); } catch { throw new ApiError("INVALID_QUERY", `${path} must be an IANA timezone`, 400); }
    }
    case "integer": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) throw new ApiError("INVALID_QUERY", `${path} must be an integer`, 400);
      return raw;
    }
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new ApiError("INVALID_QUERY", `${path} must be a finite number`, 400);
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") throw new ApiError("INVALID_QUERY", `${path} must be boolean`, 400);
      return raw ? 1 : 0;
    case "person":
    case "person_list":
    case "record":
    case "record_list":
      if (typeof raw !== "string" || !raw) throw new ApiError("INVALID_QUERY", `${path} must contain an ID`, 400);
      return raw;
    case "range<date>":
    case "range<instant>":
      throw new ApiError("INVALID_QUERY", `${path} requires range query operators`, 400);
    case "temporal_range":
    case "location":
      throw new ApiError("INVALID_QUERY", `${path} requires a typed query operator`, 400);
  }
}

function parseRangeOperand(value: unknown, path: string): RangeOperand {
  if (!isObject(value)) throw new ApiError("INVALID_QUERY", `${path} must be a range object`, 400);
  const kind = value.kind;
  if (kind === "local_date_window") {
    const startDate = exactDate(value.startDate, `${path}.startDate`);
    const endDateExclusive = exactDate(value.endDateExclusive, `${path}.endDateExclusive`);
    if (endDateExclusive <= startDate) throw new ApiError("INVALID_QUERY", `${path}.endDateExclusive must be later than startDate`, 400);
    if (typeof value.timezone !== "string") throw new ApiError("INVALID_QUERY", `${path}.timezone must be an IANA timezone`, 400);
    let timezone: string;
    try { timezone = assertIanaTimezone(value.timezone); } catch { throw new ApiError("INVALID_QUERY", `${path}.timezone must be an IANA timezone`, 400); }
    return { kind, startDate, endDateExclusive, timezone };
  }
  if (kind === "date") {
    const start = exactDate(value.start, `${path}.start`);
    const endExclusive = exactDate(value.endExclusive, `${path}.endExclusive`);
    if (endExclusive <= start) throw new ApiError("INVALID_QUERY", `${path}.endExclusive must be later than start`, 400);
    return { kind, start, endExclusive };
  }
  if (kind === "instant") {
    const start = instant(value.start, `${path}.start`);
    const endExclusive = instant(value.endExclusive, `${path}.endExclusive`);
    if (endExclusive <= start) throw new ApiError("INVALID_QUERY", `${path}.endExclusive must be later than start`, 400);
    return { kind, start, endExclusive };
  }
  throw new ApiError("INVALID_QUERY", `${path}.kind must be local_date_window, date, or instant`, 400);
}

export function normalizeCanonicalQueryOperand(
  field: FieldDefinition,
  op: string,
  value: unknown,
  path = "value",
): unknown {
  if (op === "withinDistance") {
    if (field.type !== "location") throw new ApiError("INVALID_QUERY", `${path} uses withinDistance only for Location`, 400);
    return parseSpatialOperand(value, path);
  }
  if (op === "kindIs") {
    if (field.type !== "temporal_range" || (value !== "date" && value !== "instant")) {
      throw new ApiError("INVALID_QUERY", `${path} must be date or instant for kindIs`, 400);
    }
    return value;
  }
  if (op === "within") {
    if (field.type !== "date" && field.type !== "instant" && field.type !== "datetime") {
      throw new ApiError("INVALID_QUERY", `${path} uses within only with date/instant fields`, 400);
    }
    return parseRangeOperand(value, path);
  }
  if (
    ["overlaps", "before", "after"].includes(op)
    || (op === "contains" && (isFirstClassRangeFieldType(field.type) || field.type === "temporal_range"))
  ) {
    if (!isFirstClassRangeFieldType(field.type) && field.type !== "temporal_range") {
      throw new ApiError("INVALID_QUERY", `${path} uses a range operator with a non-range field`, 400);
    }
    return parseRangeOperand(value, path);
  }
  if (op === "contains" && field.type === "enum_list") {
    if (typeof value !== "string" || !field.values?.includes(value)) {
      throw new ApiError("INVALID_QUERY", `${path} is not a declared enum value`, 400);
    }
    return value;
  }
  if (op === "contains" && ["person", "person_list", "record", "record_list"].includes(field.type)) {
    if (typeof value !== "string" || !value) throw new ApiError("INVALID_QUERY", `${path} must contain an ID`, 400);
    return value;
  }
  try {
    return normalizeCanonicalFieldValue(path, field, value);
  } catch {
    throw new ApiError("INVALID_QUERY", `${path} does not match the canonical field type`, 400);
  }
}

function projectOperand(value: RangeOperand, valueType: "date" | "instant" | "datetime", path: string): QueryRange {
  if (value.kind === "local_date_window") {
    if (valueType === "date") return { kind: "date", start: value.startDate, endExclusive: value.endDateExclusive };
    try {
      const projected = localDateWindowToInstantRange({
        dateStart: value.startDate,
        dateEndExclusive: value.endDateExclusive,
        timezone: value.timezone,
      });
      return { kind: "instant", start: projected.startInclusive, endExclusive: projected.endExclusive };
    } catch (error) {
      throw new ApiError("INVALID_QUERY", error instanceof Error ? `${path} is invalid: ${error.message}` : `${path} is invalid`, 400);
    }
  }
  if (valueType === "date" && value.kind !== "date") throw new ApiError("INVALID_QUERY", `${path} must use a date range or local_date_window`, 400);
  if ((valueType === "instant" || valueType === "datetime") && value.kind !== "instant") throw new ApiError("INVALID_QUERY", `${path} must use an instant range or local_date_window`, 400);
  return { kind: value.kind, start: value.start, endExclusive: value.endExclusive };
}

function comparisonOperator(op: CanonicalOperator): string {
  switch (op) {
    case "eq": return "=";
    case "ne": return "<>";
    case "lt": return "<";
    case "lte": return "<=";
    case "gt": return ">";
    case "gte": return ">=";
    default: throw new ApiError("INVALID_QUERY", `Operator ${op} is not a scalar comparison`, 400);
  }
}

function orderedType(field: FieldDefinition): boolean {
  return field.type === "date" || field.type === "instant" || field.type === "datetime" || field.type === "integer" || field.type === "number";
}

function equalityType(field: FieldDefinition): boolean {
  return !["location", "person", "person_list", "record", "record_list", "enum_list", "file", "file_list", "file_ref_list"].includes(field.type);
}

function relationAliasAllowed(model: PublishedModel, fieldKey: string): boolean {
  return model.definition.capabilities?.calendar?.attendeePersonField === fieldKey
    || model.definition.capabilities?.temporal?.subjectPersonField === fieldKey;
}

async function resolveRelationTarget(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  fieldKey: string,
  field: FieldDefinition,
  value: unknown,
  principalPersonId?: string | null,
): Promise<string> {
  if (value === "me") {
    if ((field.type !== "person" && field.type !== "person_list") || !relationAliasAllowed(model, fieldKey)) {
      throw new ApiError("INVALID_QUERY", `${fieldKey} does not accept the me alias`, 400);
    }
    if (principal.type !== "user") throw new ApiError("INVALID_QUERY", "me requires a user principal", 400);
    if (principalPersonId) return principalPersonId;
    const row = await env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1")
      .bind(spaceId, principal.id).first<{ id: string }>();
    if (!row) throw new ApiError("INVALID_QUERY", "me requires an active Space Person", 400);
    return row.id;
  }
  return String(scalarValue(field, value, `${fieldKey}.value`));
}

function rangePredicate(
  startExpression: string,
  endExpression: string,
  bounds: TimeRangeBounds,
  op: RangeOperator,
  operand: QueryRange,
): SqlFragment {
  const startInclusive = bounds.startsWith("[");
  const endInclusive = bounds.endsWith("]");
  switch (op) {
    case "overlaps":
      return {
        sql: `(${startExpression}< ? AND ${endExpression}${endInclusive ? ">=" : ">"}?)`.replace("< ?", "<?"),
        args: [operand.endExclusive, operand.start],
      };
    case "contains":
      return {
        sql: `(${startExpression}${startInclusive ? "<=" : "<"}? AND ${endExpression}>=?)`,
        args: [operand.start, operand.endExclusive],
      };
    case "before":
      return {
        sql: `(${endExpression}${endInclusive ? "<" : "<="}?)`,
        args: [operand.start],
      };
    case "after":
      return {
        sql: `(${startExpression}>=?)`,
        args: [operand.endExclusive],
      };
  }
}

function calendarTemporalRangePredicate(model: PublishedModel, op: RangeOperator, operand: RangeOperand): SqlFragment {
  const c = model.definition.capabilities?.calendar;
  if (!c) throw new ApiError("INVALID_QUERY", "when is only available for Calendar-backed models", 400);
  if ("rangeField" in c) {
    throw new ApiError("INVALID_QUERY", `when compatibility alias is not available for canonical Calendar binding; use ${c.rangeField}`, 400);
  }
  const allDay = typedScalarExpression(model, c.allDayField);
  const dateStart = typedScalarExpression(model, c.allDayStartField);
  const dateEnd = typedScalarExpression(model, c.allDayEndExclusiveField);
  const instantStart = typedScalarExpression(model, c.timedStartField);
  const instantEnd = typedScalarExpression(model, c.timedEndField);
  const branches: SqlFragment[] = [];
  if (operand.kind === "local_date_window" || operand.kind === "date") {
    const projected = projectOperand(operand, "date", "when.value");
    const fragment = rangePredicate(dateStart, dateEnd, "[)", op, projected);
    branches.push({ sql: `(${allDay}=1 AND ${fragment.sql})`, args: fragment.args });
  }
  if (operand.kind === "local_date_window" || operand.kind === "instant") {
    const projected = projectOperand(operand, "datetime", "when.value");
    const fragment = rangePredicate(instantStart, instantEnd, "[)", op, projected);
    branches.push({ sql: `(${allDay}=0 AND ${fragment.sql})`, args: fragment.args });
  }
  if (!branches.length) throw new ApiError("INVALID_QUERY", "when range operand is invalid", 400);
  return {
    sql: `(${branches.map((branch) => branch.sql).join(" OR ")})`,
    args: branches.flatMap((branch) => branch.args),
  };
}

function directRangeFieldPredicate(
  model: PublishedModel,
  predicate: FilterPredicate,
): SqlFragment {
  const field = model.definition.fields[predicate.field];
  if (!field || !isFirstClassRangeFieldType(field.type)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not a first-class range field`, 400);
  }
  if (!model.definition.query?.filterable?.includes(predicate.field)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not filterable for model ${model.key}`, 400);
  }
  const expressions = typedRangeExpressions(model, predicate.field);
  if (predicate.op === "isNull" || predicate.op === "isNotNull") {
    if (field.nullable !== true) {
      throw new ApiError("INVALID_QUERY", `${predicate.field} is not nullable`, 400);
    }
    const op = predicate.op === "isNull" ? "IS NULL" : "IS NOT NULL";
    return {
      sql: `(${expressions.start} ${op} AND ${expressions.end} ${op})`,
      args: [],
    };
  }
  if (!["overlaps", "contains", "before", "after"].includes(predicate.op)) {
    throw new ApiError(
      "INVALID_QUERY",
      `${predicate.field}.${predicate.op} is unsupported for a range field`,
      400,
    );
  }
  const operand = projectOperand(
    parseRangeOperand(predicate.value, `${predicate.field}.value`),
    rangeFieldValueType(field.type),
    `${predicate.field}.value`,
  );
  return rangePredicate(
    expressions.start,
    expressions.end,
    "[)",
    predicate.op as RangeOperator,
    operand,
  );
}

function temporalRangeFieldPredicate(
  model: PublishedModel,
  predicate: FilterPredicate,
): SqlFragment {
  const field = model.definition.fields[predicate.field];
  if (!field || field.type !== "temporal_range") {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not a temporal_range field`, 400);
  }
  if (!model.definition.query?.filterable?.includes(predicate.field)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not filterable for model ${model.key}`, 400);
  }
  const expressions = typedTemporalRangeExpressions(model, predicate.field);
  if (predicate.op === "isNull" || predicate.op === "isNotNull") {
    if (field.nullable !== true) {
      throw new ApiError("INVALID_QUERY", `${predicate.field} is not nullable`, 400);
    }
    return {
      sql: `${expressions.kind} IS ${predicate.op === "isNull" ? "" : "NOT "}NULL`,
      args: [],
    };
  }
  if (predicate.op === "kindIs") {
    if (predicate.value !== "date" && predicate.value !== "instant") {
      throw new ApiError(
        "INVALID_QUERY",
        `${predicate.field}.kindIs requires date or instant`,
        400,
      );
    }
    return { sql: `${expressions.kind}=?`, args: [predicate.value] };
  }
  if (!["overlaps", "contains", "before", "after"].includes(predicate.op)) {
    throw new ApiError(
      "INVALID_QUERY",
      `${predicate.field}.${predicate.op} is unsupported for temporal_range`,
      400,
    );
  }

  const operand = parseRangeOperand(predicate.value, `${predicate.field}.value`);
  const branches: SqlFragment[] = [];
  if (operand.kind === "local_date_window" || operand.kind === "date") {
    const projected = projectOperand(operand, "date", `${predicate.field}.value`);
    const fragment = rangePredicate(
      expressions.start,
      expressions.end,
      "[)",
      predicate.op as RangeOperator,
      projected,
    );
    branches.push({
      sql: `(${expressions.kind}=? AND ${fragment.sql})`,
      args: ["date", ...fragment.args],
    });
  }
  if (operand.kind === "local_date_window" || operand.kind === "instant") {
    const projected = projectOperand(operand, "datetime", `${predicate.field}.value`);
    const fragment = rangePredicate(
      expressions.start,
      expressions.end,
      "[)",
      predicate.op as RangeOperator,
      projected,
    );
    branches.push({
      sql: `(${expressions.kind}=? AND ${fragment.sql})`,
      args: ["instant", ...fragment.args],
    });
  }
  return {
    sql: `(${branches.map((branch) => branch.sql).join(" OR ")})`,
    args: branches.flatMap((branch) => branch.args),
  };
}


const EARTH_RADIUS_METERS = 6371008.8;
const MAX_SPATIAL_RADIUS_METERS = 5000000;

function parseSpatialOperand(value: unknown, path: string): {
  point: { latitude: number; longitude: number };
  meters: number;
} {
  if (!isObject(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "point")
    || !Object.hasOwn(value, "meters")
    || !isObject(value.point)
    || Object.keys(value.point).length !== 2
    || !Object.hasOwn(value.point, "latitude")
    || !Object.hasOwn(value.point, "longitude")) {
    throw new ApiError("INVALID_QUERY", `${path} must contain only point{latitude,longitude} and meters`, 400);
  }
  const { latitude, longitude } = value.point;
  const { meters } = value;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof meters !== "number" || !Number.isFinite(meters) || meters <= 0 || meters > MAX_SPATIAL_RADIUS_METERS) {
    throw new ApiError("INVALID_QUERY", `${path} requires WGS84 coordinates and a distance in (0, 5000000] meters`, 400);
  }
  return { point: { latitude, longitude }, meters };
}

function locationDistancePredicate(model: PublishedModel, predicate: FilterPredicate): SqlFragment {
  const field = model.definition.fields[predicate.field];
  if (!field || field.type !== "location" || !model.definition.query?.filterable?.includes(predicate.field)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not a filterable Location field`, 400);
  }
  const expressions = typedLocationExpressions(model, predicate.field);
  if (predicate.op === "isNull" || predicate.op === "isNotNull") {
    if (field.nullable !== true) throw new ApiError("INVALID_QUERY", `${predicate.field} is not nullable`, 400);
    return { sql: `${expressions.name} IS ${predicate.op === "isNull" ? "" : "NOT "}NULL`, args: [] };
  }
  if (predicate.op !== "withinDistance") {
    throw new ApiError("INVALID_QUERY", `${predicate.field} supports withinDistance only`, 400);
  }
  const { point, meters } = parseSpatialOperand(predicate.value, `${predicate.field}.value`);
  const angular = meters / EARTH_RADIUS_METERS;
  const latDelta = angular * 180 / Math.PI;
  const minLat = Math.max(-90, point.latitude - latDelta);
  const maxLat = Math.min(90, point.latitude + latDelta);
  const { latitude: lat, longitude: lon } = expressions;
  const clauses = [`${lat} BETWEEN ? AND ?`];
  const args: unknown[] = [minLat, maxLat];

  // A bounding window narrows candidates through the (space_id, latitude, longitude)
  // index before the exact great-circle test. Never hide a coordinate-less Location.
  if (minLat > -90 && maxLat < 90) {
    const lonDelta = Math.asin(Math.min(1, Math.sin(angular) / Math.cos(point.latitude * Math.PI / 180))) * 180 / Math.PI;
    const minLon = point.longitude - lonDelta;
    const maxLon = point.longitude + lonDelta;
    if (minLon < -180) {
      clauses.push(`(${lon} >= ? OR ${lon} <= ?)`);
      args.push(minLon + 360, maxLon);
    } else if (maxLon > 180) {
      clauses.push(`(${lon} >= ? OR ${lon} <= ?)`);
      args.push(minLon, maxLon - 360);
    } else {
      clauses.push(`${lon} BETWEEN ? AND ?`);
      args.push(minLon, maxLon);
    }
  }

  // Haversine great-circle distance: SQLite/D1 mathematical functions are
  // supported. Clamp the floating-point intermediate to avoid asin domain drift.
  clauses.push(`(2 * ${EARTH_RADIUS_METERS} * asin(min(1, sqrt(
    pow(sin(radians(${lat}-?)/2),2)
    + cos(radians(?)) * cos(radians(${lat}))
    * pow(sin(radians(${lon}-?)/2),2)
  )))) <= ?`);
  args.push(point.latitude, point.latitude, point.longitude, meters);
  return { sql: `(${clauses.join(" AND ")})`, args };
}

function validateFilterShape(value: unknown, depth = 0, counter = { value: 0 }): CanonicalFilter {
  if (!isObject(value)) throw new ApiError("INVALID_QUERY", "filter nodes must be objects", 400);
  if (depth > MAX_FILTER_DEPTH) throw new ApiError("INVALID_QUERY", `filter depth may not exceed ${MAX_FILTER_DEPTH}`, 400);
  counter.value += 1;
  if (counter.value > MAX_FILTER_NODES) throw new ApiError("INVALID_QUERY", `filter may not exceed ${MAX_FILTER_NODES} nodes`, 400);
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === "and" || keys[0] === "or")) {
    const operator = keys[0] as "and" | "or";
    const children = value[operator];
    if (!Array.isArray(children) || !children.length) throw new ApiError("INVALID_QUERY", `${operator} requires at least one child`, 400);
    return { [operator]: children.map((child) => validateFilterShape(child, depth + 1, counter)) } as CanonicalFilter;
  }
  if (!keys.every((key) => ["field", "op", "value"].includes(key))) throw new ApiError("INVALID_QUERY", "predicate accepts only field, op, and value", 400);
  if (typeof value.field !== "string" || !value.field) throw new ApiError("INVALID_QUERY", "predicate.field must be a non-empty string", 400);
  if (typeof value.op !== "string" || !FILTER_OPERATORS.has(value.op as CanonicalOperator)) throw new ApiError("INVALID_QUERY", "predicate.op is unsupported", 400);
  const op = value.op as CanonicalOperator;
  const needsValue = op !== "isNull" && op !== "isNotNull";
  if (needsValue && !Object.prototype.hasOwnProperty.call(value, "value")) throw new ApiError("INVALID_QUERY", `${value.field}.${op} requires value`, 400);
  if (!needsValue && Object.prototype.hasOwnProperty.call(value, "value")) throw new ApiError("INVALID_QUERY", `${value.field}.${op} does not accept value`, 400);
  return { field: value.field, op, ...(needsValue ? { value: value.value } : {}) };
}

function parseViewingContext(raw: unknown): ViewingContext | undefined {
  if (raw === undefined) return undefined;
  if (
    !isObject(raw)
    || Object.keys(raw).some((key) => key !== "viewingTimezone")
    || typeof raw.viewingTimezone !== "string"
  ) {
    throw new ApiError("INVALID_QUERY", "context must be {viewingTimezone:string}", 400);
  }
  try {
    return { viewingTimezone: assertIanaTimezone(raw.viewingTimezone) };
  } catch {
    throw new ApiError("INVALID_QUERY", "context.viewingTimezone must be an IANA timezone", 400);
  }
}

function parseSorts(
  model: PublishedModel,
  raw: unknown,
  context: ViewingContext | undefined,
): SortCriterion[] {
  const values = raw === undefined ? [{ field: "createdAt", direction: "desc" as const }] : raw;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_SORT_CRITERIA) {
    throw new ApiError("INVALID_QUERY", `sort must contain 1-${MAX_SORT_CRITERIA} criteria`, 400);
  }
  const seen = new Set<string>();
  const sorts: SortCriterion[] = values.map((value, index): SortCriterion => {
    if (!isObject(value) || !Object.keys(value).every((key) => key === "field" || key === "direction")) {
      throw new ApiError("INVALID_QUERY", `sort[${index}] must contain field and direction`, 400);
    }
    const field = value.field;
    const direction = value.direction;
    if (typeof field !== "string" || (direction !== "asc" && direction !== "desc")) {
      throw new ApiError("INVALID_QUERY", `sort[${index}] is invalid`, 400);
    }
    if (seen.has(field)) throw new ApiError("INVALID_QUERY", `sort field ${field} may be supplied only once`, 400);
    seen.add(field);
    if (field === "createdAt") return { raw: `${field}:${direction}`, field, direction, expression: "r.created_at", nullable: false };
    if (field === "updatedAt") return { raw: `${field}:${direction}`, field, direction, expression: "r.updated_at", nullable: false };

    const declared = model.definition.fields[field];
    if (declared && isFirstClassRangeFieldType(declared.type)) {
      throw new ApiError(
        "INVALID_QUERY",
        `${field} range sorting is not defined by the current Canonical Query contract`,
        400,
      );
    }
    if (declared?.type === "location") throw new ApiError("INVALID_QUERY", `${field} cannot be sorted`, 400);
    if (declared?.type === "temporal_range") {
      if (!model.definition.query?.sortable?.includes(field)) {
        throw new ApiError("INVALID_QUERY", `${field} is not sortable for model ${model.key}`, 400);
      }
      if (!context) {
        throw new ApiError(
          "INVALID_QUERY",
          `${field} sorting requires context.viewingTimezone`,
          400,
        );
      }
      const expressions = typedTemporalRangeExpressions(model, field);
      return {
        raw: `${field}:${direction}:${context.viewingTimezone}`,
        field,
        direction,
        expression: expressions.start,
        nullable: declared.nullable === true || declared.required !== true,
        temporal: { ...expressions, viewingTimezone: context.viewingTimezone },
      };
    }
    if (field === "when") {
      throw new ApiError(
        "INVALID_QUERY",
        "Calendar compatibility when sorting remains on the Calendar transport until Event migration",
        400,
      );
    }
    if (!model.definition.query?.sortable?.includes(field)) throw new ApiError("INVALID_QUERY", `${field} is not sortable for model ${model.key}`, 400);
    return {
      raw: `${field}:${direction}`,
      field,
      direction,
      expression: typedScalarExpression(model, field),
      nullable: declared?.nullable === true || declared?.required !== true,
    };
  });
  const temporalCount = sorts.filter((sort) => sort.temporal).length;
  if (temporalCount > 1) {
    throw new ApiError("INVALID_QUERY", "Canonical Query supports at most one temporal_range sort field", 400);
  }
  if (context && temporalCount === 0) {
    throw new ApiError(
      "INVALID_QUERY",
      "context.viewingTimezone is only valid with a temporal_range sort",
      400,
    );
  }
  return sorts;
}

function parseInput(model: PublishedModel, input: unknown): {
  query: NormalizedQuery;
  sorts: SortCriterion[];
  limit: number;
  cursor: string | null;
} {
  if (!isObject(input)) throw new ApiError("INVALID_QUERY", "Canonical Query body must be an object", 400);
  const unknown = Object.keys(input).find((key) => !["search", "filter", "sort", "context", "page"].includes(key));
  if (unknown) throw new ApiError("INVALID_QUERY", `Unsupported Canonical Query member ${unknown}`, 400);
  let search: { text: string } | undefined;
  if (input.search !== undefined) {
    if (!isObject(input.search) || Object.keys(input.search).some((key) => key !== "text") || typeof input.search.text !== "string") {
      throw new ApiError("INVALID_QUERY", "search must be {text:string}", 400);
    }
    const text = input.search.text.trim();
    if (!text || text.length > 100) throw new ApiError("INVALID_QUERY", "search.text must contain 1-100 characters", 400);
    if (!(model.definition.query?.searchable?.length)) throw new ApiError("INVALID_QUERY", `Model ${model.key} does not expose searchable fields`, 400);
    search = { text };
  }
  const filter = input.filter === undefined ? undefined : normalizeFilter(validateFilterShape(input.filter));
  const context = parseViewingContext(input.context);
  const sorts = parseSorts(model, input.sort, context);
  let limit = 100;
  let cursor: string | null = null;
  if (input.page !== undefined) {
    if (!isObject(input.page) || Object.keys(input.page).some((key) => key !== "limit" && key !== "cursor")) {
      throw new ApiError("INVALID_QUERY", "page accepts only limit and cursor", 400);
    }
    if (input.page.limit !== undefined) {
      if (!Number.isInteger(input.page.limit) || Number(input.page.limit) < 1 || Number(input.page.limit) > 200) {
        throw new ApiError("INVALID_QUERY", "page.limit must be an integer between 1 and 200", 400);
      }
      limit = Number(input.page.limit);
    }
    if (input.page.cursor !== undefined && input.page.cursor !== null && typeof input.page.cursor !== "string") {
      throw new ApiError("INVALID_QUERY", "page.cursor must be a string or null", 400);
    }
    cursor = typeof input.page.cursor === "string" && input.page.cursor ? input.page.cursor : null;
  }
  return {
    query: {
      ...(search ? { search } : {}),
      ...(filter ? { filter } : {}),
      sort: sorts.map(({ field, direction }) => ({ field, direction })),
      ...(context ? { context } : {}),
    },
    sorts,
    limit,
    cursor,
  };
}

function encodeCursor(cursor: Cursor | TemporalCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isCursorScalar(value: unknown): value is CursorScalar {
  return value === null || typeof value === "string" || typeof value === "number";
}

function decodeCursor(raw: string): Cursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Cursor>;
    if (
      value.v !== 3
      || typeof value.model !== "string"
      || typeof value.signature !== "string"
      || !Array.isArray(value.sorts)
      || value.sorts.some((sort) => typeof sort !== "string")
      || !Array.isArray(value.keys)
      || value.keys.length !== value.sorts.length
      || value.keys.some((key) => !isCursorScalar(key))
      || typeof value.id !== "string"
    ) throw new Error("invalid cursor");
    return value as Cursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function decodeTemporalCursor(raw: string): TemporalCursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TemporalCursor>;
    if (
      value.v !== 4
      || typeof value.model !== "string"
      || typeof value.signature !== "string"
      || !Array.isArray(value.sorts)
      || value.sorts.some((sort) => typeof sort !== "string")
      || !isObject(value.streams)
    ) throw new Error("invalid cursor");
    for (const [variant, state] of Object.entries(value.streams)) {
      if (
        !["date", "instant", "null"].includes(variant)
        || !isObject(state)
        || !Array.isArray(state.keys)
        || state.keys.some((key) => !isCursorScalar(key))
        || typeof state.id !== "string"
      ) throw new Error("invalid stream cursor");
    }
    return value as TemporalCursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function cursorPredicate(sorts: SortCriterion[], keys: CursorScalar[], id: string): SqlFragment {
  const build = (index: number): SqlFragment => {
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

function scalarFilter(model: PublishedModel, predicate: FilterPredicate): SqlFragment {
  const field = model.definition.fields[predicate.field];
  if (!field) throw new ApiError("INVALID_QUERY", `${predicate.field} is not a declared model field`, 400);
  if (!model.definition.query?.filterable?.includes(predicate.field)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field} is not filterable for model ${model.key}`, 400);
  }
  const expression = typedScalarExpression(model, predicate.field);
  if (predicate.op === "isNull" || predicate.op === "isNotNull") {
    if (field.nullable !== true) throw new ApiError("INVALID_QUERY", `${predicate.field} is not nullable`, 400);
    return { sql: `${expression} IS ${predicate.op === "isNull" ? "" : "NOT "}NULL`, args: [] };
  }
  if (predicate.op === "within") {
    if (field.type !== "date" && field.type !== "instant" && field.type !== "datetime") throw new ApiError("INVALID_QUERY", `${predicate.field}.within requires date or instant`, 400);
    const range = projectOperand(parseRangeOperand(predicate.value, `${predicate.field}.value`), field.type, `${predicate.field}.value`);
    return { sql: `(${expression}>=? AND ${expression}<?)`, args: [range.start, range.endExclusive] };
  }
  if (["lt", "lte", "gt", "gte"].includes(predicate.op)) {
    if (!orderedType(field)) throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} requires an ordered scalar`, 400);
  } else if (predicate.op === "eq" || predicate.op === "ne") {
    if (!equalityType(field)) throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} is not valid for relation/list fields; use contains where supported`, 400);
  } else {
    throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} is not a scalar operator`, 400);
  }
  return {
    sql: `${expression}${comparisonOperator(predicate.op)}?`,
    args: [scalarValue(field, predicate.value, `${predicate.field}.value`)],
  };
}

function envelopeFilter(predicate: FilterPredicate): SqlFragment {
  const expression = predicate.field === "createdAt" ? "r.created_at" : "r.updated_at";
  if (predicate.op === "isNull" || predicate.op === "isNotNull") throw new ApiError("INVALID_QUERY", `${predicate.field} is never null`, 400);
  if (predicate.op === "within") {
    const range = projectOperand(parseRangeOperand(predicate.value, `${predicate.field}.value`), "datetime", `${predicate.field}.value`);
    return { sql: `(${expression}>=? AND ${expression}<?)`, args: [range.start, range.endExclusive] };
  }
  if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(predicate.op)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} is unsupported`, 400);
  }
  return { sql: `${expression}${comparisonOperator(predicate.op)}?`, args: [instant(predicate.value, `${predicate.field}.value`)] };
}

function timeRangeFilter(model: PublishedModel, predicate: FilterPredicate): SqlFragment | null {
  const range = projectTimeRangeSemantics(model.definition).find((candidate) => candidate.key === predicate.field && candidate.source === "model");
  if (!range) return null;
  if (!model.definition.query?.filterable?.includes(range.startField) || !model.definition.query?.filterable?.includes(range.endField)) {
    throw new ApiError("INVALID_QUERY", `time range ${range.key} requires both bound fields to be filterable`, 400);
  }
  if (!["overlaps", "contains", "before", "after"].includes(predicate.op)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} is unsupported for a time range`, 400);
  }
  const operand = projectOperand(parseRangeOperand(predicate.value, `${predicate.field}.value`), range.valueType, `${predicate.field}.value`);
  return rangePredicate(
    typedScalarExpression(model, range.startField),
    typedScalarExpression(model, range.endField),
    range.bounds,
    predicate.op as RangeOperator,
    operand,
  );
}

async function predicateFragment(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  predicate: FilterPredicate,
  principalPersonId?: string | null,
): Promise<SqlFragment> {
  const projectedTarget = canonicalQuerySemanticDescriptor(model).filter.targets
    .find((target) => target.field === predicate.field);
  if (projectedTarget && !projectedTarget.operators.includes(predicate.op)) {
    throw new ApiError("INVALID_QUERY", `${predicate.field}.${predicate.op} is unsupported`, 400);
  }
  if (predicate.field === "createdAt" || predicate.field === "updatedAt") return envelopeFilter(predicate);
  const declaredField = model.definition.fields[predicate.field];
  if (declaredField && isFirstClassRangeFieldType(declaredField.type)) {
    return directRangeFieldPredicate(model, predicate);
  }
  if (declaredField?.type === "temporal_range") {
    return temporalRangeFieldPredicate(model, predicate);
  }
  if (declaredField?.type === "location") return locationDistancePredicate(model, predicate);
  if (predicate.field === "when") {
    const calendar = model.definition.capabilities?.calendar;
    if (!calendar) throw new ApiError("INVALID_QUERY", "when is not available for this model", 400);
    if ("rangeField" in calendar) {
      throw new ApiError("INVALID_QUERY", `when compatibility alias is not available for canonical Calendar binding; use ${calendar.rangeField}`, 400);
    }
    if (predicate.op === "kindIs") {
      if (predicate.value !== "date" && predicate.value !== "instant") throw new ApiError("INVALID_QUERY", "when.kindIs requires date or instant", 400);
      return {
        sql: `${typedScalarExpression(model, calendar.allDayField)}=?`,
        args: [predicate.value === "date" ? 1 : 0],
      };
    }
    if (!["overlaps", "contains", "before", "after"].includes(predicate.op)) throw new ApiError("INVALID_QUERY", `when.${predicate.op} is unsupported`, 400);
    return calendarTemporalRangePredicate(model, predicate.op as RangeOperator, parseRangeOperand(predicate.value, "when.value"));
  }
  const range = timeRangeFilter(model, predicate);
  if (range) return range;
  const field = model.definition.fields[predicate.field];
  if (field && ["person", "person_list", "record", "record_list"].includes(field.type)) {
    if (!model.definition.query?.filterable?.includes(predicate.field)) throw new ApiError("INVALID_QUERY", `${predicate.field} is not filterable for model ${model.key}`, 400);
    if (predicate.op !== "contains") throw new ApiError("INVALID_QUERY", `${predicate.field} uses contains for relation membership`, 400);
    const target = await resolveRelationTarget(env, principal, spaceId, model, predicate.field, field, predicate.value, principalPersonId);
    const person = field.type === "person" || field.type === "person_list";
    return {
      sql: `EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type=? AND ${person ? "rel.target_person_id" : "rel.target_record_id"}=?)`,
      args: [predicate.field, person ? "person" : "record", target],
    };
  }
  return scalarFilter(model, predicate);
}

function combineBooleanFragments(operator: "AND" | "OR", fragments: SqlFragment[]): SqlFragment {
  function balancedSql(start: number, end: number): string {
    if (end - start === 1) return fragments[start].sql;
    const midpoint = start + Math.floor((end - start) / 2);
    return `(${balancedSql(start, midpoint)} ${operator} ${balancedSql(midpoint, end)})`;
  }
  return {
    sql: balancedSql(0, fragments.length),
    args: fragments.flatMap((fragment) => fragment.args),
  };
}

async function compileFilter(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  filter: CanonicalFilter,
  principalPersonId?: string | null,
): Promise<SqlFragment> {
  if ("and" in filter) {
    const fragments = await Promise.all(
      filter.and.map((child) => compileFilter(env, principal, spaceId, model, child, principalPersonId)),
    );
    return combineBooleanFragments("AND", fragments);
  }
  if ("or" in filter) {
    const fragments = await Promise.all(
      filter.or.map((child) => compileFilter(env, principal, spaceId, model, child, principalPersonId)),
    );
    return combineBooleanFragments("OR", fragments);
  }
  return predicateFragment(env, principal, spaceId, model, filter, principalPersonId);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function searchFragment(model: PublishedModel, text: string): SqlFragment {
  const clauses: string[] = [];
  const args: unknown[] = [];
  for (const fieldKey of model.definition.query?.searchable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field) continue;
    const expression = field.type === "location"
      ? typedLocationExpressions(model, fieldKey).name
      : ["string", "text", "enum"].includes(field.type)
        ? typedScalarExpression(model, fieldKey)
        : null;
    if (!expression) continue;
    clauses.push(`lower(CAST(${expression} AS TEXT)) LIKE lower(?) ESCAPE '\\'`);
    args.push(`%${escapeLike(text)}%`);
  }
  if (!clauses.length) throw new ApiError("INVALID_QUERY", `Model ${model.key} has no text-searchable fields`, 400);
  return { sql: `(${clauses.join(" OR ")})`, args };
}

function temporalStreamSorts(
  sorts: SortCriterion[],
): SortCriterion[] {
  return sorts.flatMap((sort) => {
    if (!sort.temporal) return [sort];
    const nullable = sort.nullable;
    return [
      {
        raw: `${sort.raw}:projectedStart`,
        field: sort.field,
        direction: sort.direction,
        expression: sort.temporal.start,
        nullable,
      },
      {
        raw: `${sort.raw}:projectedEnd`,
        field: sort.field,
        direction: sort.direction,
        expression: sort.temporal.end,
        nullable,
      },
    ];
  });
}

function temporalProjectedKeys(
  row: QueryRow,
  variant: TemporalVariant,
  sorts: SortCriterion[],
): CursorScalar[] {
  const keys: CursorScalar[] = [];
  let effectiveIndex = 0;
  for (const sort of sorts) {
    if (!sort.temporal) {
      keys.push(row[`sort_value_${effectiveIndex}`] ?? null);
      effectiveIndex += 1;
      continue;
    }
    const start = row[`sort_value_${effectiveIndex}`] ?? null;
    const endExclusive = row[`sort_value_${effectiveIndex + 1}`] ?? null;
    effectiveIndex += 2;
    if (variant === "null") {
      keys.push(null, null);
      continue;
    }
    if (typeof start !== "string" || typeof endExclusive !== "string") {
      throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Temporal range sort value is invalid for resource ${row.id}`, 500);
    }
    if (variant === "instant") {
      keys.push(start, endExclusive);
      continue;
    }
    try {
      const projected = localDateWindowToInstantRange({
        dateStart: start,
        dateEndExclusive: endExclusive,
        timezone: sort.temporal.viewingTimezone,
      });
      keys.push(projected.startInclusive, projected.endExclusive);
    } catch {
      throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Temporal range sort value is invalid for resource ${row.id}`, 500);
    }
  }
  return keys;
}

function temporalSortDirections(sorts: SortCriterion[]): Direction[] {
  return sorts.flatMap((sort) => sort.temporal
    ? [sort.direction, sort.direction]
    : [sort.direction]);
}

function compareProjectedKey(
  left: CursorScalar,
  right: CursorScalar,
  direction: Direction,
): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const order = left < right ? -1 : left > right ? 1 : 0;
  return direction === "asc" ? order : -order;
}

async function queryTemporalSortedResources(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  parsed: ReturnType<typeof parseInput>,
  signature: string,
  baseWhere: string[],
  baseArgs: unknown[],
): Promise<CanonicalQueryResult> {
  const temporal = parsed.sorts.find((sort) => sort.temporal)?.temporal;
  if (!temporal) throw new ApiError("INVALID_QUERY", "Temporal sort context is missing", 400);
  const rawSorts = parsed.sorts.map((sort) => sort.raw);
  const cursor = parsed.cursor ? decodeTemporalCursor(parsed.cursor) : null;
  if (
    cursor
    && (
      cursor.model !== model.key
      || cursor.signature !== signature
      || cursor.sorts.length !== rawSorts.length
      || cursor.sorts.some((value, index) => value !== rawSorts[index])
    )
  ) throw new ApiError("INVALID_QUERY", "cursor does not match this Canonical Query", 400);

  const variants: TemporalVariant[] = ["date", "instant", "null"];
  const scalarSelect = typedSelectColumns(model);
  const statements = variants.map((variant) => {
    const sorts = temporalStreamSorts(parsed.sorts);
    const where = [...baseWhere];
    const args = [...baseArgs];
    if (variant === "null") {
      where.push(`${temporal.kind} IS NULL`);
    } else {
      where.push(`${temporal.kind}=?`);
      args.push(variant);
    }
    const streamCursor = cursor?.streams[variant];
    if (streamCursor) {
      if (streamCursor.keys.length !== sorts.length) {
        throw new ApiError("INVALID_QUERY", "cursor does not match this Canonical Query", 400);
      }
      const continuation = cursorPredicate(sorts, streamCursor.keys, streamCursor.id);
      where.push(continuation.sql);
      args.push(...continuation.args);
    }
    const sortSelect = sorts.map(
      (sort, index) => `${sort.expression} AS sort_value_${index}`,
    ).join(",");
    const order = sorts.flatMap((sort) => [
      ...(sort.nullable ? [`${sort.expression} IS NULL ASC`] : []),
      `${sort.expression} ${sort.direction.toUpperCase()}`,
    ]);
    order.push("r.id ASC");
    args.push(parsed.limit + 1);
    if (args.length > MAX_QUERY_BINDINGS) {
      throw new ApiError("INVALID_QUERY", "Canonical Query exceeds the execution complexity budget", 400);
    }
    return env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at,${resourceAuditSelectColumns("r")}${scalarSelect ? `,${scalarSelect}` : ""},${sortSelect}\n      FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id\n      ${resourceAuditJoins("r")}\n      WHERE ${where.join(" AND ")} ORDER BY ${order.join(",")} LIMIT ?`)
      .bind(...args);
  });

  const results = await env.DB.batch<QueryRow>(statements);
  const directions = temporalSortDirections(parsed.sorts);
  const candidates = variants.flatMap((variant, index) =>
    results[index]!.results.map((row) => ({
      variant,
      row,
      projected: temporalProjectedKeys(row, variant, parsed.sorts),
    }))
  ).sort((left, right) => {
    for (let index = 0; index < directions.length; index += 1) {
      const order = compareProjectedKey(
        left.projected[index] ?? null,
        right.projected[index] ?? null,
        directions[index]!,
      );
      if (order) return order;
    }
    return left.row.id.localeCompare(right.row.id);
  });

  const page = candidates.slice(0, parsed.limit);
  const streams: Partial<Record<TemporalVariant, TemporalStreamCursor>> = {
    ...(cursor?.streams ?? {}),
  };
  for (const candidate of page) {
    const sorts = temporalStreamSorts(parsed.sorts);
    streams[candidate.variant] = {
      keys: sorts.map((_sort, index) => candidate.row[`sort_value_${index}`] ?? null),
      id: candidate.row.id,
    };
  }
  const items = await hydrateTypedResourceRows(env, model, page.map((candidate) => candidate.row));
  return {
    items,
    nextCursor: candidates.length > parsed.limit
      ? encodeCursor({
          v: 4,
          model: model.key,
          signature,
          sorts: rawSorts,
          streams,
        })
      : null,
  };
}

export async function queryCanonicalResources(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  input: unknown,
  principalPersonId?: string | null,
): Promise<CanonicalQueryResult> {
  const parsed = parseInput(model, input);
  const signature = stableJson(parsed.query);
  const rawSorts = parsed.sorts.map((sort) => sort.raw);
  const args: unknown[] = [spaceId, model.key];
  const where: string[] = ["r.space_id=?", "r.model_key=?", "r.deleted_at IS NULL"];
  if (parsed.query.search) {
    const fragment = searchFragment(model, parsed.query.search.text);
    where.push(fragment.sql);
    args.push(...fragment.args);
  }
  if (parsed.query.filter) {
    const fragment = await compileFilter(env, principal, spaceId, model, parsed.query.filter, principalPersonId);
    where.push(fragment.sql);
    args.push(...fragment.args);
  }

  if (parsed.sorts.some((sort) => sort.temporal)) {
    return queryTemporalSortedResources(env, spaceId, model, parsed, signature, where, args);
  }

  const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : null;
  if (cursor) {
    if (
      cursor.model !== model.key
      || cursor.signature !== signature
      || cursor.sorts.length !== rawSorts.length
      || cursor.sorts.some((value, index) => value !== rawSorts[index])
      || cursor.keys.length !== parsed.sorts.length
    ) throw new ApiError("INVALID_QUERY", "cursor does not match this Canonical Query", 400);
    const continuation = cursorPredicate(parsed.sorts, cursor.keys, cursor.id);
    where.push(continuation.sql);
    args.push(...continuation.args);
  }

  const scalarSelect = typedSelectColumns(model);
  const sortSelect = parsed.sorts.map((sort, index) => `${sort.expression} AS sort_value_${index}`).join(",");
  const order = parsed.sorts.flatMap((sort) => [
    ...(sort.nullable ? [`${sort.expression} IS NULL ASC`] : []),
    `${sort.expression} ${sort.direction.toUpperCase()}`,
  ]);
  order.push("r.id ASC");
  args.push(parsed.limit + 1);
  if (args.length > MAX_QUERY_BINDINGS) {
    throw new ApiError("INVALID_QUERY", "Canonical Query exceeds the execution complexity budget", 400);
  }
  const rows = await env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at,${resourceAuditSelectColumns("r")}${scalarSelect ? `,${scalarSelect}` : ""},${sortSelect}\n    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id\n    ${resourceAuditJoins("r")}\n    WHERE ${where.join(" AND ")} ORDER BY ${order.join(",")} LIMIT ?`)
    .bind(...args).all<QueryRow>();
  const page = rows.results.slice(0, parsed.limit);
  const items = await hydrateTypedResourceRows(env, model, page);
  const last = page.at(-1);
  const nextCursor = rows.results.length > parsed.limit && last
    ? encodeCursor({
        v: 3,
        model: model.key,
        signature,
        sorts: rawSorts,
        keys: parsed.sorts.map((_sort, index) => last[`sort_value_${index}`] ?? null),
        id: last.id,
      })
    : null;
  return { items, nextCursor };
}
