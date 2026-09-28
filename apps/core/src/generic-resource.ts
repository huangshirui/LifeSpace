import type { Bindings, Principal } from "./env";
import { chunkD1Values } from "./d1-batch";
import { ApiError } from "./http";
import { applyModelDefaults } from "./model-defaults";
import { isFirstClassRangeFieldType, rangeFieldValueType, type FieldDefinition, type ModelDefinition } from "./model-definition";
import { validateRangeValue } from "./range-value";
import { resourceAuditActor, type ResourceAudit } from "./resource-audit";
import { validateTemporalRangeValue } from "./temporal-range";
import { assertIanaTimezone, normalizeRfc3339Instant } from "./time-semantics";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import {
  getTypedResource,
  listTypedResources,
  typedInsertStatement,
  typedUpdateStatement,
} from "./typed-resource-storage";

type JsonObject = Record<string, unknown>;
type ChangeOperation = "create" | "update" | "action" | "delete";

export type ResourceFieldChangeValue =
  | { present: false }
  | { present: true; value: unknown };

export type ResourceFieldChange = {
  field: string;
  before: ResourceFieldChangeValue;
  after: ResourceFieldChangeValue;
};

export type GenericResource = {
  id: string;
  spaceId: string;
  modelKey: string;
  modelVersion: number;
  data: JsonObject;
  audit?: ResourceAudit;
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

export type MutationAttribution = {
  delegationId?: string | null;
  changeSetId?: string | null;
};

export type RelationProjection = {
  fieldKey: string;
  targetType: "person" | "record";
  targetId: string;
  targetModelKey?: string;
  ordinal: number;
};

const createId = () => `rec_${crypto.randomUUID().replaceAll("-", "")}`;
const changeId = () => `chg_${crypto.randomUUID().replaceAll("-", "")}`;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function operationActor(principal: Principal) {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function principalAuditName(principal: Principal): string {
  return principal.displayName?.trim() || principal.id;
}

function principalResourceAuditActor(principal: Principal) {
  return resourceAuditActor(principal.type, principal.id, principalAuditName(principal), null);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function fieldValue(data: JsonObject, field: string): ResourceFieldChangeValue {
  return Object.prototype.hasOwnProperty.call(data, field)
    ? { present: true, value: data[field] }
    : { present: false };
}

export function exactFieldChanges(before: JsonObject, after: JsonObject): ResourceFieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields.flatMap((field) => {
    const previous = fieldValue(before, field);
    const next = fieldValue(after, field);
    if (previous.present === next.present
        && (!previous.present || !next.present || equalJson(previous.value, next.value))) {
      return [];
    }
    return [{ field, before: previous, after: next }];
  });
}

function changeStatement(
  env: Bindings,
  principal: Principal,
  id: string,
  recordId: string,
  spaceId: string,
  modelKey: string,
  operation: ChangeOperation,
  actionKey: string | null,
  versionBefore: number | null,
  versionAfter: number,
  changedFields: string[],
  fieldChanges: ResourceFieldChange[],
  timestamp: string,
  attribution: MutationAttribution = {},
  mutationToken?: string,
): D1PreparedStatement {
  if (principal.actor?.type === "agent" && !attribution.delegationId) {
    throw new ApiError("DELEGATION_REQUIRED", "Delegated Agent mutation requires current Delegation authority", 403);
  }
  if (operation === "action" && !actionKey) {
    throw new ApiError("CHANGE_EVIDENCE_INCOMPLETE", "Action mutation requires semantic actionKey evidence", 500);
  }
  if (operation !== "action" && actionKey) {
    throw new ApiError("CHANGE_EVIDENCE_INCOMPLETE", "Only Action mutations may carry actionKey evidence", 500);
  }
  const actor = operationActor(principal);
  const values = [
    id,
    recordId,
    spaceId,
    modelKey,
    operation,
    actionKey,
    versionBefore,
    versionAfter,
    principal.type,
    principal.id,
    actor.type,
    actor.id,
    principal.clientId,
    attribution.delegationId ?? null,
    attribution.changeSetId ?? null,
    JSON.stringify([...new Set(changedFields)].sort()),
    JSON.stringify(fieldChanges),
    timestamp,
  ];
  if (!mutationToken) {
    return env.DB.prepare(`INSERT INTO resource_changes(
      id,record_id,space_id,model_key,operation,action_key,version_before,version_after,
      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,
      changed_fields_json,field_changes_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values);
  }
  return env.DB.prepare(`INSERT INTO resource_changes(
      id,record_id,space_id,model_key,operation,action_key,version_before,version_after,
      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,
      changed_fields_json,field_changes_json,occurred_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)
    .bind(...values, recordId, mutationToken);
}

function appendChangeSetOutboxLink(
  statements: D1PreparedStatement[],
  env: Bindings,
  changeId: string,
  attribution: MutationAttribution,
): void {
  if (!attribution.changeSetId) return;
  statements.push(env.DB.prepare(`UPDATE domain_event_outbox
    SET change_set_id=?
    WHERE change_id=? AND change_set_id IS NULL`)
    .bind(attribution.changeSetId, changeId));
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
  try {
    return normalizeRfc3339Instant(value);
  } catch {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be an absolute RFC 3339 date-time`, 400);
  }
}

function parseTimezone(value: unknown, fieldKey: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid IANA timezone`, 400);
  try {
    return assertIanaTimezone(value);
  } catch {
    throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be a valid IANA timezone`, 400);
  }
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
    case "instant":
    case "datetime": return parseDateTime(value, fieldKey);
    case "range<date>":
    case "range<instant>": {
      if (!isFirstClassRangeFieldType(field.type)) throw new ApiError("INVALID_RESOURCE", `${fieldKey} has invalid range type`, 400);
      const result = validateRangeValue(value, rangeFieldValueType(field.type));
      if (!result.valid) {
        throw new ApiError(
          "INVALID_RESOURCE",
          `${fieldKey} is invalid: ${result.issues.map((entry) => entry.message).join("; ")}`,
          400,
        );
      }
      return result.value;
    }
    case "timezone": return parseTimezone(value, fieldKey);
    case "enum":
      if (typeof value !== "string" || !field.values?.includes(value)) throw new ApiError("INVALID_RESOURCE", `${fieldKey} must be one of the declared enum values`, 400);
      return value;
    case "person":
    case "record": return relationIds(value, fieldKey, false)[0];
    case "person_list":
    case "record_list": return relationIds(value, fieldKey, true);
    case "temporal_range": {
      const result = validateTemporalRangeValue(value);
      if (!result.valid) {
        throw new ApiError(
          "INVALID_RESOURCE",
          `${fieldKey} is invalid: ${result.issues.map((entry) => entry.message).join("; ")}`,
          400,
        );
      }
      return result.value;
    }
  }
}

export function validateResourceData(
  definition: ModelDefinition,
  input: unknown,
  mode: "create" | "create_internal" | "update" | "action",
  previous?: JsonObject,
): JsonObject {
  if (!isObject(input)) throw new ApiError("INVALID_RESOURCE", "Resource body must be an object", 400);

  const creating = mode === "create" || mode === "create_internal";
  const trusted = mode === "create_internal" || mode === "action";
  const effectiveInput = creating ? applyModelDefaults(definition, input) : input;
  const unknown = Object.keys(input).find((key) => !definition.fields[key]);
  if (unknown) throw new ApiError("INVALID_RESOURCE", `Field ${unknown} is not declared by model ${definition.key}`, 400);

  const result: JsonObject = creating ? {} : { ...(previous ?? {}) };
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const supplied = Object.prototype.hasOwnProperty.call(effectiveInput, fieldKey);
    const clientSupplied = Object.prototype.hasOwnProperty.call(input, fieldKey);
    if (field.readOnly && clientSupplied && !trusted) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is read-only`, 400);
    if (!creating && field.immutable && supplied && previous?.[fieldKey] !== effectiveInput[fieldKey]) {
      throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is immutable`, 400);
    }
    if (!supplied) {
      if (creating && field.required && !field.readOnly) throw new ApiError("INVALID_RESOURCE", `Field ${fieldKey} is required`, 400);
      continue;
    }
    result[fieldKey] = validateFieldValue(fieldKey, field, effectiveInput[fieldKey]);
  }
  return result;
}

export function collectRelationProjections(
  definition: ModelDefinition,
  data: JsonObject,
): RelationProjection[] {
  const relations: RelationProjection[] = [];
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const value = data[fieldKey];
    if (value === undefined || value === null) continue;
    if (field.type === "person" || field.type === "person_list") {
      const ids = relationIds(value, fieldKey, field.type === "person_list");
      ids.forEach((targetId, ordinal) => {
        relations.push({ fieldKey, targetType: "person", targetId, ordinal });
      });
    }
    if (field.type === "record" || field.type === "record_list") {
      const ids = relationIds(value, fieldKey, field.type === "record_list");
      const targetModelKey = field.targetModel!;
      ids.forEach((targetId, ordinal) => {
        relations.push({ fieldKey, targetType: "record", targetId, targetModelKey, ordinal });
      });
    }
  }
  return relations;
}

export async function validateRelationProjections(
  env: Bindings,
  spaceId: string,
  relations: readonly RelationProjection[],
): Promise<void> {
  const personIds = new Set(
    relations.filter((relation) => relation.targetType === "person").map((relation) => relation.targetId),
  );
  const recordIdsByModel = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.targetType !== "record") continue;
    if (!relation.targetModelKey) {
      throw new ApiError("INVALID_RESOURCE_RELATION", "Record relation is missing its target model", 500);
    }
    const ids = recordIdsByModel.get(relation.targetModelKey) ?? new Set<string>();
    ids.add(relation.targetId);
    recordIdsByModel.set(relation.targetModelKey, ids);
  }

  const validations: Array<{
    expected: Set<string>;
    statements: D1PreparedStatement[];
    message: string;
  }> = [];

  if (personIds.size) {
    validations.push({
      expected: personIds,
      statements: chunkD1Values([...personIds], 1).map((chunk) =>
        env.DB.prepare(`SELECT id FROM space_people
          WHERE space_id=? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, ...chunk),
      ),
      message: "Every Person relation must reference an active Person in the same Space",
    });
  }

  for (const [targetModel, ids] of recordIdsByModel) {
    validations.push({
      expected: ids,
      statements: chunkD1Values([...ids], 2).map((chunk) =>
        env.DB.prepare(`SELECT id FROM resource_records
          WHERE space_id=? AND model_key=? AND deleted_at IS NULL
            AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, targetModel, ...chunk),
      ),
      message: `Every record relation must reference an active ${targetModel} record in the same Space`,
    });
  }

  const statements = validations.flatMap((validation) => validation.statements);
  if (!statements.length) return;

  const results = await env.DB.batch<{ id: string }>(statements);
  let offset = 0;
  for (const validation of validations) {
    const found = new Set<string>();
    for (let index = 0; index < validation.statements.length; index += 1) {
      for (const row of results[offset + index]?.results ?? []) found.add(row.id);
    }
    offset += validation.statements.length;
    if (found.size !== validation.expected.size) {
      throw new ApiError("INVALID_RESOURCE_RELATION", validation.message, 400);
    }
  }
}

async function projectRelations(
  env: Bindings,
  spaceId: string,
  definition: ModelDefinition,
  data: JsonObject,
): Promise<RelationProjection[]> {
  const relations = collectRelationProjections(definition, data);
  await validateRelationProjections(env, spaceId, relations);
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
  attribution: MutationAttribution = {},
): Promise<GenericResource> {
  const data = validateResourceData(model.definition, input, trustedCapabilityInput ? "create_internal" : "create");
  const relations = await projectRelations(env, spaceId, model.definition, data);
  const id = createId();
  const timestamp = new Date().toISOString();
  const mutationToken = changeId();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO resource_records(
      id,space_id,model_key,model_version,created_by_type,created_by_id,created_by_name_snapshot,
      updated_by_type,updated_by_id,updated_by_name_snapshot,version,mutation_token,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).bind(
      id,
      spaceId,
      model.key,
      model.version,
      principal.type,
      principal.id,
      principalAuditName(principal),
      principal.type,
      principal.id,
      principalAuditName(principal),
      mutationToken,
      timestamp,
      timestamp,
    ),
    typedInsertStatement(env, model, id, spaceId, data),
    ...relationStatements(env, id, spaceId, model, relations),
  ];
  if (extension) statements.push(...await extension({ env, principal, recordId: id, spaceId, model, timestamp, mutationToken }));
  statements.push(changeStatement(
    env,
    principal,
    mutationToken,
    id,
    spaceId,
    model.key,
    "create",
    null,
    null,
    1,
    Object.keys(data),
    exactFieldChanges({}, data),
    timestamp,
    attribution,
    mutationToken,
  ));
  appendChangeSetOutboxLink(statements, env, mutationToken, attribution);
  statements.push(env.DB.prepare("UPDATE resource_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(id, mutationToken));
  await env.DB.batch(statements);
  const auditActor = principalResourceAuditActor(principal);
  return {
    id,
    spaceId,
    modelKey: model.key,
    modelVersion: model.version,
    data,
    audit: { createdBy: auditActor, updatedBy: auditActor },
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
  actionKey?: string,
  attribution: MutationAttribution = {},
): Promise<GenericResource> {
  const previous = previousResource ?? await getTypedResource(env, spaceId, model, recordId);
  if (!previous || previous.id !== recordId || previous.spaceId !== spaceId || previous.modelKey !== model.key) {
    throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  }
  if (previous.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);

  const data = validateResourceData(model.definition, input, mutationMode === "action" ? "action" : "update", previous.data);
  const relations = await projectRelations(env, spaceId, model.definition, data);
  const timestamp = new Date().toISOString();
  const mutationToken = changeId();
  const nextVersion = previous.version + 1;
  const changedFields = isObject(input) ? Object.keys(input) : [];
  const fieldChanges = exactFieldChanges(previous.data, data);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE resource_records SET
      model_version=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,version=?,updated_at=?,mutation_token=?
      WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
      .bind(model.version, principal.type, principal.id, principalAuditName(principal), nextVersion, timestamp, mutationToken, recordId, spaceId, model.key, expectedVersion),
    typedUpdateStatement(env, model, recordId, spaceId, data, mutationToken),
    ...relationStatements(env, recordId, spaceId, model, relations, mutationToken),
  ];
  if (extension) statements.push(...await extension({ env, principal, recordId, spaceId, model, timestamp, mutationToken }));
  statements.push(changeStatement(
    env,
    principal,
    mutationToken,
    recordId,
    spaceId,
    model.key,
    mutationMode === "action" ? "action" : "update",
    mutationMode === "action" ? (actionKey ?? null) : null,
    expectedVersion,
    nextVersion,
    changedFields,
    fieldChanges,
    timestamp,
    attribution,
    mutationToken,
  ));
  appendChangeSetOutboxLink(statements, env, mutationToken, attribution);
  statements.push(env.DB.prepare("UPDATE resource_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(recordId, mutationToken));
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  const updatedBy = principalResourceAuditActor(principal);
  return {
    id: recordId,
    spaceId,
    modelKey: model.key,
    modelVersion: model.version,
    data,
    ...(previous.audit ? { audit: { createdBy: previous.audit.createdBy, updatedBy } } : {}),
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
  attribution: MutationAttribution = {},
): Promise<void> {
  const previous = await getTypedResource(env, spaceId, model, recordId);
  if (!previous || previous.id !== recordId || previous.spaceId !== spaceId || previous.modelKey !== model.key) {
    throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  }
  if (previous.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);

  const timestamp = new Date().toISOString();
  const mutationToken = changeId();
  const nextVersion = expectedVersion + 1;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE resource_records SET
      deleted_at=?,updated_at=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,version=version+1,mutation_token=?
      WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
      .bind(timestamp, timestamp, principal.type, principal.id, principal.id, mutationToken, recordId, spaceId, model.key, expectedVersion),
    changeStatement(
      env,
      principal,
      mutationToken,
      recordId,
      spaceId,
      model.key,
      "delete",
      null,
      expectedVersion,
      nextVersion,
      [],
      exactFieldChanges(previous.data, {}),
      timestamp,
      attribution,
      mutationToken,
    ),
    ...(attribution.changeSetId
      ? [env.DB.prepare(`UPDATE domain_event_outbox
          SET change_set_id=?
          WHERE change_id=? AND change_set_id IS NULL`).bind(attribution.changeSetId, mutationToken)]
      : []),
    env.DB.prepare(`DELETE FROM resource_relations WHERE source_record_id=?
      AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)
      .bind(recordId, recordId, mutationToken),
    env.DB.prepare("UPDATE resource_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(recordId, mutationToken),
  ]);
  if (!results[0].meta.changes) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
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
