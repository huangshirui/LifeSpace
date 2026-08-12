import type { Bindings, Principal } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";

type ResourceRow = {
  id: string;
  space_id: string;
  model_key: string;
  model_version: number;
  data_json: string;
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
  sort_value: string | number | null;
};

type Cursor = {
  v: 1;
  model: string;
  sort: string;
  key: string | number | null;
  id: string;
  signature: string;
};

export type GenericQueryResult = {
  items: GenericResource[];
  nextCursor: string | null;
};

function rowToResource(row: ResourceRow): GenericResource {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data_json) as Record<string, unknown>;
  } catch {
    throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Resource ${row.id} contains invalid JSON`, 500);
  }
  return {
    id: row.id,
    spaceId: row.space_id,
    modelKey: row.model_key,
    modelVersion: row.model_version,
    data,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string): Cursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Cursor>;
    if (
      value.v !== 1
      || typeof value.model !== "string"
      || typeof value.sort !== "string"
      || (value.key !== null && typeof value.key !== "string" && typeof value.key !== "number")
      || typeof value.id !== "string"
      || typeof value.signature !== "string"
    ) throw new Error("invalid cursor");
    return value as Cursor;
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

function jsonExpression(fieldKey: string): string {
  return `json_extract(r.data_json,'$.${fieldKey}')`;
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

function parseSort(model: PublishedModel, params: URLSearchParams): { raw: string; field: string; direction: "asc" | "desc"; expression: string; nullable: boolean } {
  const raw = one(params, "sort") ?? "createdAt:desc";
  const [field, direction, ...rest] = raw.split(":");
  if (rest.length || !field || (direction !== "asc" && direction !== "desc")) throw new ApiError("INVALID_QUERY", "sort must use field:asc or field:desc", 400);
  if (field === "createdAt") return { raw, field, direction, expression: "r.created_at", nullable: false };
  if (field === "updatedAt") return { raw, field, direction, expression: "r.updated_at", nullable: false };
  if (!model.definition.query?.sortable?.includes(field)) throw new ApiError("INVALID_QUERY", `${field} is not a sortable field for model ${model.key}`, 400);
  return { raw, field, direction, expression: jsonExpression(field), nullable: model.definition.fields[field]?.nullable === true || model.definition.fields[field]?.required !== true };
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
  const sort = parseSort(model, params);
  const signature = querySignature(params);
  const args: unknown[] = [spaceId, model.key];
  let sql = `SELECT r.*,${sort.expression} AS sort_value FROM resource_records r WHERE r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL`;

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
      clauses.push(`lower(CAST(${jsonExpression(fieldKey)} AS TEXT)) LIKE lower(?) ESCAPE '\\'`);
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
        sql += ` AND ${jsonExpression(fieldKey)} IN (${parsed.map(() => "?").join(",")})`;
        args.push(...parsed);
      } else {
        sql += ` AND ${jsonExpression(fieldKey)}=?`;
        args.push(scalarValue(field, exact, fieldKey));
      }
    }

    const from = one(params, `${fieldKey}From`);
    const to = one(params, `${fieldKey}To`);
    if (from !== undefined) {
      sql += ` AND ${jsonExpression(fieldKey)}>=?`;
      args.push(rangeValue(field, from, `${fieldKey}From`));
    }
    if (to !== undefined) {
      sql += ` AND ${jsonExpression(fieldKey)}<=?`;
      args.push(rangeValue(field, to, `${fieldKey}To`));
    }
  }

  const rawCursor = one(params, "cursor");
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (cursor.model !== model.key || cursor.sort !== sort.raw || cursor.signature !== signature) throw new ApiError("INVALID_QUERY", "cursor does not match this model/query", 400);
    const operator = sort.direction === "asc" ? ">" : "<";
    if (sort.nullable && cursor.key === null) {
      sql += ` AND ${sort.expression} IS NULL AND r.id>?`;
      args.push(cursor.id);
    } else if (sort.nullable) {
      sql += ` AND ((${sort.expression} IS NOT NULL AND (${sort.expression}${operator}? OR (${sort.expression}=? AND r.id>?))) OR ${sort.expression} IS NULL)`;
      args.push(cursor.key, cursor.key, cursor.id);
    } else {
      sql += ` AND (${sort.expression}${operator}? OR (${sort.expression}=? AND r.id>?))`;
      args.push(cursor.key, cursor.key, cursor.id);
    }
  }

  sql += sort.nullable ? ` ORDER BY ${sort.expression} IS NULL ASC,${sort.expression} ${sort.direction.toUpperCase()},r.id ASC` : ` ORDER BY ${sort.expression} ${sort.direction.toUpperCase()},r.id ASC`;
  sql += " LIMIT ?";
  args.push(limit + 1);

  const rows = await env.DB.prepare(sql).bind(...args).all<ResourceRow>();
  const page = rows.results.slice(0, limit);
  const items = page.map(rowToResource);
  const last = page.at(-1);
  const nextCursor = rows.results.length > limit && last
    ? encodeCursor({ v: 1, model: model.key, sort: sort.raw, key: last.sort_value, id: last.id, signature })
    : null;
  return { items, nextCursor };
}
