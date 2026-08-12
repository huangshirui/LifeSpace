import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { FieldDefinition, ModelDefinition } from "./model-definition";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import {
  getTypedResource,
  listTypedResources,
  typedInsertStatement,
  typedUpdateStatement,
} from "./typed-resource-storage";

type JsonObject = Record<string, unknown>;

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

export type ResourceMutationExtensionContext = {
  env: Bindings;
  principal: Principal;
  recordId: string;
  spaceId: string;
  model: PublishedModel;
  timestamp: string;
  mutationToken?: string;
};

export type ResourceMutationExtension = (
  context: ResourceMutationExtensionContext,
) => Promise<D1PreparedStatement[]> | D1PreparedStatement[];

type RelationProjection = {
  fieldKey: string;
  targetType: "person" | "record";
  targetId: string;
  ordinal: number;
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
  mode: "create" | "create_internal" | "update" | "action",
  previous?: JsonObject,
): JsonObject {
  if (!isObject(input)) throw new ApiError("INVALID_RESOURCE", "Resource body must be an object", 400);
  const unknown = Object.keys(input).find((key) => !definition.fields[key]);
  if (unknown) throw new ApiError("INVALID_RESOURCE", `Field ${unknown} is not declared by model ${definition.key}`, 400);

  const creating = mode === "create" || mode === "create_internal";
  const trusted = mode === "create_internal" || mode === "action";
  const result: JsonObject = creating ? {} : { ...(previous ?? {}) };
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const supplied = Object.prototype.hasOwnProperty.call(input, fieldKey);
    if (field.readOnly && supplied && !trusted) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is read-only`, 400);
    if (!creating && field.immutable && supplied && previous?.[fieldKey] !== input[fieldKey]) {
      throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is immutable`, 400);
    }
    if (!supplied) {
      if (creating && field.required && !field.readOnly) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is required`, 400);
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

function relationStatements(
  env: Bindings,
  recordId: string,
  spaceId: string,
  model: PublishedModel,
  relations: RelationProjection[],
  mutationToken?: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (mutationToken) {
    statements.push(env.DB.prepare(`DELETE FROM resource_relations WHERE source_record_id=?
      AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`).bind(recordId, recordId, mutationToken));
  }
  for (const relation of relations) {
    if (mutationToken) {
      statements.push(env.DB.prepare(`INSERT INTO resource_relations(
        source_record_id,source_space_id,source_model_key,field_key,ordinal,target_type,target_person_id,target_record_id
      ) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`).bind(
        recordId,
        spaceId,
        model.key,
        relation.fieldKey,
        relation.ordinal,
        relation.targetType,
        relation.targetType === "person" ? relation.targetId : null,
        relation.targetType === "record" ? relation.targetId : null,
        recordId,
        mutationToken,
      ));
    } else {
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
  }
  return statements;
}

async function resolveModel(env: Bindings, modelOrKey: PublishedModel | string): Promise<PublishedModel | null> {
  if (typeof modelOrKey !== "string") return modelOrKey;
  return getRuntimeModel(env, modelOrKey);
}

export async function createGenericResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  input: unknown,
  trustedCapabilityInput = false,
  extension?: ResourceMutationExtension,
): Promise<GenericResource> {
  const data = validateResourceData(model.definition, input, trustedCapabilityInput ? "create_internal" : "create");
  const relations = await projectRelations(env, spaceId, model.definition, data);
  const id = createId();
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO resource_records(
      id,space_id,model_key,model_version,created_by_type,created_by_id,created_by_name_snapshot,
      updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
      id,
      spaceId,
      model.key,
      model.version,
      principal.type,
      principal.id,
      principal.id,
      principal.type,
      principal.id,
      principal.id,
      timestamp,
      timestamp,
    ),
    typedInsertStatement(env, model, id, spaceId, data),
    ...relationStatements(env, id, spaceId, model, relations),
  ];
  if (extension) statements.push(...await extension({ env, principal, recordId: id, spaceId, model, timestamp }));
  await env.DB.batch(statements);
  return {
    id,
    spaceId,
    modelKey: model.key,
    modelVersion: model.version,
    data,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function getGenericResource(
  env: Bindings,
  spaceId: string,
  modelOrKey: PublishedModel | string,
  recordId: string,
): Promise<GenericResource | null> {
  const model = await resolveModel(env, modelOrKey);
  if (!model) return null;
  return getTypedResource(env, spaceId, model, recordId);
}

export async function updateGenericResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
  input: unknown,
  mutationMode: "client" | "action" = "client",
  extension?: ResourceMutationExtension,
  previousResource?: GenericResource,
): Promise<GenericResource> {
  const previous = previousResource ?? await getTypedResource(env, spaceId, model, recordId);
  if (!previous || previous.id !== recordId || previous.spaceId !== spaceId || previous.modelKey !== model.key) {
    throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  }
  if (previous.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);

  const data = validateResourceData(model.definition, input, mutationMode === "action" ? "action" : "update", previous.data);
  const relations = await projectRelations(env, spaceId, model.definition, data);
  const timestamp = new Date().toISOString();
  const mutationToken = crypto.randomUUID();
  const nextVersion = previous.version + 1;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE resource_records SET
      model_version=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,version=?,updated_at=?,mutation_token=?
      WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
      .bind(model.version, principal.type, principal.id, principal.id, nextVersion, timestamp, mutationToken, recordId, spaceId, model.key, expectedVersion),
    typedUpdateStatement(env, model, recordId, spaceId, data, mutationToken),
    ...relationStatements(env, recordId, spaceId, model, relations, mutationToken),
  ];
  if (extension) statements.push(...await extension({ env, principal, recordId, spaceId, model, timestamp, mutationToken }));
  statements.push(env.DB.prepare("UPDATE resource_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(recordId, mutationToken));
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  return {
    id: recordId,
    spaceId,
    modelKey: model.key,
    modelVersion: model.version,
    data,
    version: nextVersion,
    createdAt: previous.createdAt,
    updatedAt: timestamp,
  };
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
    const existing = await getTypedResource(env, spaceId, model, recordId);
    if (!existing) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  }
  await env.DB.prepare("DELETE FROM resource_relations WHERE source_record_id=?").bind(recordId).run();
}

export async function listGenericResources(
  env: Bindings,
  spaceId: string,
  modelOrKey: PublishedModel | string,
  limit = 100,
): Promise<GenericResource[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_REQUEST", "limit must be between 1 and 200", 400);
  const model = await resolveModel(env, modelOrKey);
  if (!model) return [];
  return listTypedResources(env, spaceId, model, limit);
}
