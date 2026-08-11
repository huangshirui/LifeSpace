import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { FieldDefinition, ModelDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";

type JsonObject = Record<string, unknown>;

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
};

export type GenericResource = {
  id: string;
  spaceId: string;
  modelKey: string;
  modelVersion: number;
  data: JsonObject;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type RelationProjection = {
  fieldKey: string;
  targetType: "person" | "record";
  targetId: string;
  ordinal: number;
};

type IndexProjection = {
  fieldKey: string;
  valueType: "text" | "number" | "date" | "datetime" | "boolean";
  textValue: string | null;
  numberValue: number | null;
  booleanValue: number | null;
};

const createId = () => `rec_${crypto.randomUUID().replaceAll("-", "")}`;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDate(value: unknown, fieldKey: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be YYYY-MM-DD`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid date`, 400);
  }
  return value;
}

function parseDateTime(value: unknown, fieldKey: string): string {
  if (typeof value !== "string") throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be an RFC 3339 date-time`, 400);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/T/.test(value)) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be an RFC 3339 date-time`, 400);
  return parsed.toISOString();
}

function parseTimezone(value: unknown, fieldKey: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid IANA timezone`, 400);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid IANA timezone`, 400);
  }
  return value;
}

function stringValue(value: unknown, fieldKey: string, definition: FieldDefinition): string {
  if (typeof value !== "string") throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a string`, 400);
  const normalized = definition.type === "string" ? value.trim() : value;
  if (definition.minLength !== undefined && normalized.length < definition.minLength) throw new ApiError("INVALID_RESOURCE", `${fieldKey} is shorter than minLength`, 400);
  if (definition.maxLength !== undefined && normalized.length > definition.maxLength) throw new ApiError("INVALID_RESOURCE", `${fieldKey} exceeds maxLength`, 400);
  return normalized;
}

function numericValue(value: unknown, fieldKey: string, definition: FieldDefinition): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (definition.type === "integer" && !Number.isInteger(value))) {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid ${definition.type}`, 400);
  }
  if (definition.minimum !== undefined && value < definition.minimum) throw new ApiError("INVALID_RESOURCE", `${fieldKey} is below minimum`, 400);
  if (definition.maximum !== undefined && value > definition.maximum) throw new ApiError("INVALID_RESOURCE", `${fieldKey} exceeds maximum`, 400);
  return value;
}

function relationIds(value: unknown, fieldKey: string, many: boolean): string[] {
  const values = many ? value : [value];
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry)) {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must contain valid IDs`, 400);
  }
  const ids = values as string[];
  if (new Set(ids).size !== ids.length) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must not contain duplicate IDs`, 400);
  return ids;
}

function validateFieldValue(fieldKey: string, field: FieldDefinition, value: unknown): unknown {
  if (value === null) {
    if (field.nullable) return null;
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} cannot be null`, 400);
  }
  switch (field.type) {
    case "string":
    case "text": return stringValue(value, fieldKey, field);
    case "integer":
    case "number": return numericValue(value, fieldKey, field);
    case "boolean":
      if (typeof value !== "boolean") throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be boolean`, 400);
      return value;
    case "date": return parseDate(value, fieldKey);
    case "datetime": return parseDateTime(value, fieldKey);
    case "timezone": return parseTimezone(value, fieldKey);
    case "enum":
      if (typeof value !== "string" || !field.values?.includes(value)) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be one of the declared enum values`, 400);
      return value;
    case "person":
    case "record": return relationIds(value, fieldKey, false)[0];
    case "person_list":
    case "record_list": return relationIds(value, fieldKey, true);
  }
}

export function validateResourceData(
  definition: ModelDefinition,
  input: unknown,
  mode: "create" | "update",
  previous?: JsonObject,
): JsonObject {
  if (!isObject(input)) throw new ApiError("INVALID_RESOURCE", "Resource body must be an object", 400);
  const unknown = Object.keys(input).find((key) => !definition.fields[key]);
  if (unknown) throw new ApiError("INVALID_RESOURCE", `Field ${unknown} is not declared by model ${definition.key}`, 400);

  const result: JsonObject = mode === "update" ? { ...(previous ?? {}) } : {};
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const supplied = Object.prototype.hasOwnProperty.call(input, fieldKey);
    if (field.readOnly && supplied) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is read-only`, 400);
    if (mode === "update" && field.immutable && supplied && previous?.[fieldKey] !== input[fieldKey]) {
      throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is immutable`, 400);
    }
    if (!supplied) {
      if (mode === "create" && field.required && !field.readOnly) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is required`, 400);
      continue;
    }
    result[fieldKey] = validateFieldValue(fieldKey, field, input[fieldKey]);
  }
  return result;
}

async function requireActivePeople(env: Bindings, spaceId: string, personIds: string[]): Promise<void> {
  if (!personIds.length) return;
  const placeholders = personIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id FROM space_people WHERE space_id=? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .bind(spaceId, ...personIds).all<{ id: string }>();
  if (rows.results.length !== personIds.length) throw new ApiError("INVALID_RESOURCE_RELATION", "Every Person relation must reference an active Person in the same Space", 400);
}

async function requireRecordTargets(env: Bindings, spaceId: string, targetModel: string, recordIds: string[]): Promise<void> {
  if (!recordIds.length) return;
  const placeholders = recordIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id FROM resource_records WHERE space_id=? AND model_key=? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .bind(spaceId, targetModel, ...recordIds).all<{ id: string }>();
  if (rows.results.length !== recordIds.length) throw new ApiError("INVALID_RESOURCE_RELATION", `Every record relation must reference an active ${targetModel} record in the same Space`, 400);
}

async function projectRelations(env: Bindings, spaceId: string, definition: ModelDefinition, data: JsonObject): Promise<RelationProjection[]> {
  const relations: RelationProjection[] = [];
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const value = data[fieldKey];
    if (value === undefined || value === null) continue;
    if (field.type === "person" || field.type === "person_list") {
      const ids = relationIds(value, fieldKey, field.type === "person_list");
      await requireActivePeople(env, spaceId, ids);
      ids.forEach((targetId, ordinal) => relations.push({ fieldKey, targetType: "person", targetId, ordinal }));
    }
    if (field.type === "record" || field.type === "record_list") {
      const ids = relationIds(value, fieldKey, field.type === "record_list");
      await requireRecordTargets(env, spaceId, field.targetModel!, ids);
      ids.forEach((targetId, ordinal) => relations.push({ fieldKey, targetType: "record", targetId, ordinal }));
    }
  }
  return relations;
}

function projectIndexes(definition: ModelDefinition, data: JsonObject): IndexProjection[] {
  const declared = new Set([...(definition.query?.filterable ?? []), ...(definition.query?.sortable ?? [])]);
  const values: IndexProjection[] = [];
  for (const fieldKey of declared) {
    const field = definition.fields[fieldKey];
    const value = data[fieldKey];
    if (!field || value === undefined || value === null || Array.isArray(value)) continue;
    if (field.type === "string" || field.type === "text" || field.type === "enum" || field.type === "timezone") {
      values.push({ fieldKey, valueType: "text", textValue: String(value), numberValue: null, booleanValue: null });
    } else if (field.type === "date" || field.type === "datetime") {
      values.push({ fieldKey, valueType: field.type, textValue: String(value), numberValue: null, booleanValue: null });
    } else if (field.type === "integer" || field.type === "number") {
      values.push({ fieldKey, valueType: "number", textValue: null, numberValue: Number(value), booleanValue: null });
    } else if (field.type === "boolean") {
      values.push({ fieldKey, valueType: "boolean", textValue: null, numberValue: null, booleanValue: value ? 1 : 0 });
    }
  }
  return values;
}

function rowToResource(row: ResourceRow): GenericResource {
  let data: JsonObject;
  try {
    data = JSON.parse(row.data_json) as JsonObject;
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

async function replaceProjections(
  env: Bindings,
  recordId: string,
  spaceId: string,
  model: PublishedModel,
  data: JsonObject,
): Promise<D1PreparedStatement[]> {
  const relations = await projectRelations(env, spaceId, model.definition, data);
  const indexes = projectIndexes(model.definition, data);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM resource_relations WHERE source_record_id=?").bind(recordId),
    env.DB.prepare("DELETE FROM resource_index_values WHERE record_id=?").bind(recordId),
  ];
  for (const relation of relations) {
    statements.push(env.DB.prepare(`INSERT INTO resource_relations(
      source_record_id,source_space_id,source_model_key,field_key,ordinal,target_type,target_person_id,target_record_id
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      recordId,
      spaceId,
      model.key,
      relation.fieldKey,
      relation.ordinal,
      relation.targetType,
      relation.targetType === "person" ? relation.targetId : null,
      relation.targetType === "record" ? relation.targetId : null,
    ));
  }
  for (const index of indexes) {
    statements.push(env.DB.prepare(`INSERT INTO resource_index_values(
      record_id,space_id,model_key,field_key,value_type,text_value,number_value,boolean_value
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      recordId,
      spaceId,
      model.key,
      index.fieldKey,
      index.valueType,
      index.textValue,
      index.numberValue,
      index.booleanValue,
    ));
  }
  return statements;
}

export async function createGenericResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  input: unknown,
): Promise<GenericResource> {
  const data = validateResourceData(model.definition, input, "create");
  const id = createId();
  const timestamp = new Date().toISOString();
  const statements = [env.DB.prepare(`INSERT INTO resource_records(
    id,space_id,model_key,model_version,data_json,created_by_type,created_by_id,created_by_name_snapshot,
    updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
    id,
    spaceId,
    model.key,
    model.version,
    JSON.stringify(data),
    principal.type,
    principal.id,
    principal.id,
    principal.type,
    principal.id,
    principal.id,
    timestamp,
    timestamp,
  ), ...(await replaceProjections(env, id, spaceId, model, data))];
  await env.DB.batch(statements);
  const created = await getGenericResource(env, spaceId, model.key, id);
  if (!created) throw new ApiError("RESOURCE_STORAGE_INCONSISTENT", "Created resource could not be read back", 500);
  return created;
}

export async function getGenericResource(env: Bindings, spaceId: string, modelKey: string, recordId: string): Promise<GenericResource | null> {
  const row = await env.DB.prepare(`SELECT * FROM resource_records WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL`)
    .bind(recordId, spaceId, modelKey).first<ResourceRow>();
  return row ? rowToResource(row) : null;
}

export async function updateGenericResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
  input: unknown,
): Promise<GenericResource> {
  const row = await env.DB.prepare(`SELECT * FROM resource_records WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL`)
    .bind(recordId, spaceId, model.key).first<ResourceRow>();
  if (!row) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (row.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  const previous = rowToResource(row);
  const data = validateResourceData(model.definition, input, "update", previous.data);
  const timestamp = new Date().toISOString();
  const nextVersion = row.version + 1;
  const projections = await replaceProjections(env, recordId, spaceId, model, data);
  const statements = [env.DB.prepare(`UPDATE resource_records SET
    data_json=?,model_version=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,version=?,updated_at=?
    WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
    .bind(JSON.stringify(data), model.version, principal.type, principal.id, principal.id, nextVersion, timestamp, recordId, spaceId, model.key, expectedVersion), ...projections];
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  const updated = await getGenericResource(env, spaceId, model.key, recordId);
  if (!updated) throw new ApiError("RESOURCE_STORAGE_INCONSISTENT", "Updated resource could not be read back", 500);
  return updated;
}

export async function deleteGenericResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE resource_records SET
    deleted_at=?,updated_at=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,version=version+1
    WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
    .bind(timestamp, timestamp, principal.type, principal.id, principal.id, recordId, spaceId, model.key, expectedVersion).run();
  if (!result.meta.changes) {
    const existing = await getGenericResource(env, spaceId, model.key, recordId);
    if (!existing) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM resource_relations WHERE source_record_id=?").bind(recordId),
    env.DB.prepare("DELETE FROM resource_index_values WHERE record_id=?").bind(recordId),
  ]);
}

export async function listGenericResources(
  env: Bindings,
  spaceId: string,
  modelKey: string,
  limit = 100,
): Promise<GenericResource[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_REQUEST", "limit must be between 1 and 200", 400);
  const rows = await env.DB.prepare(`SELECT * FROM resource_records
    WHERE space_id=? AND model_key=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(spaceId, modelKey, limit).all<ResourceRow>();
  return rows.results.map(rowToResource);
}
