import type { Bindings } from "./env";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import { ApiError } from "./http";
import { isFirstClassRangeFieldType, rangeFieldValueType, type FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import {
  compilePhysicalSchema,
  type PhysicalFieldMapping,
  type PhysicalSchemaPlan,
} from "./physical-schema";
import { validateRangeValue } from "./range-value";
import {
  resourceAuditFromStorage,
  type ResourceAudit,
  type ResourceAuditStorageRow,
} from "./resource-audit";
import { validateTemporalRangeValue } from "./temporal-range";

type JsonObject = Record<string, unknown>;

export type TypedResourceRow = Partial<ResourceAuditStorageRow> & {
  id: string;
  space_id: string;
  model_key: string;
  model_version: number;
  version: number;
  created_at: string;
  updated_at: string;
  sort_value?: string | number | null;
  [key: string]: unknown;
};

export type TypedStoredResource = {
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

type RelationRow = {
  source_record_id: string;
  field_key: string;
  ordinal: number;
  target_person_id: string | null;
  target_record_id: string | null;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const planCache = new WeakMap<object, PhysicalSchemaPlan>();

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Unsafe physical identifier ${value}`, 500);
  return `"${value}"`;
}

function fieldAlias(fieldKey: string): string {
  return `__field_${fieldKey}`;
}

export function resourceAuditSelectColumns(alias = "r"): string {
  return [
    `${alias}.created_by_type`,
    `${alias}.created_by_id`,
    `${alias}.created_by_name_snapshot`,
    "created_person.display_name AS created_current_name",
    `${alias}.updated_by_type`,
    `${alias}.updated_by_id`,
    `${alias}.updated_by_name_snapshot`,
    "updated_person.display_name AS updated_current_name",
  ].join(",");
}

export function resourceAuditJoins(alias = "r"): string {
  return `LEFT JOIN space_people created_person
      ON ${alias}.created_by_type='user'
      AND created_person.space_id=${alias}.space_id
      AND created_person.linked_user_id=${alias}.created_by_id
      AND created_person.deleted_at IS NULL
    LEFT JOIN space_people updated_person
      ON ${alias}.updated_by_type='user'
      AND updated_person.space_id=${alias}.space_id
      AND updated_person.linked_user_id=${alias}.updated_by_id
      AND updated_person.deleted_at IS NULL`;
}

export function physicalPlanFor(model: PublishedModel): PhysicalSchemaPlan {
  const key = model.definition as unknown as object;
  const cached = planCache.get(key);
  if (cached) return cached;
  const plan = compilePhysicalSchema(model.definition);
  planCache.set(key, plan);
  return plan;
}

export function typedTableSql(model: PublishedModel): string {
  return identifier(physicalPlanFor(model).tableName);
}

export function typedScalarExpression(model: PublishedModel, fieldKey: string, alias = "m"): string {
  const plan = physicalPlanFor(model);
  if (!plan.columns.some((column) => column.fieldKey === fieldKey)) {
    throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Field ${fieldKey} is not a typed scalar field for model ${model.key}`, 500);
  }
  return `${alias}.${identifier(fieldKey)}`;
}

export type TypedTemporalRangeExpressions = {
  kind: string;
  start: string;
  end: string;
};

export type TypedRangeExpressions = {
  start: string;
  end: string;
};

export function typedRangeExpressions(
  model: PublishedModel,
  fieldKey: string,
  alias = "m",
): TypedRangeExpressions {
  const mapping = physicalPlanFor(model).fieldMappings.find(
    (candidate) => candidate.fieldKey === fieldKey,
  );
  if (!mapping || mapping.storage !== "range") {
    throw new ApiError(
      "INVALID_PHYSICAL_SCHEMA",
      `Field ${fieldKey} is not a typed range field for model ${model.key}`,
      500,
    );
  }
  const columns = rangeComponents(mapping);
  return {
    start: `${alias}.${identifier(columns.start)}`,
    end: `${alias}.${identifier(columns.end)}`,
  };
}

export function typedTemporalRangeExpressions(
  model: PublishedModel,
  fieldKey: string,
  alias = "m",
): TypedTemporalRangeExpressions {
  const mapping = physicalPlanFor(model).fieldMappings.find(
    (candidate) => candidate.fieldKey === fieldKey,
  );
  if (!mapping || mapping.storage !== "temporal_range") {
    throw new ApiError(
      "INVALID_PHYSICAL_SCHEMA",
      `Field ${fieldKey} is not a typed temporal_range field for model ${model.key}`,
      500,
    );
  }
  const columns = temporalComponents(mapping);
  return {
    kind: `${alias}.${identifier(columns.kind)}`,
    start: `${alias}.${identifier(columns.start)}`,
    end: `${alias}.${identifier(columns.end)}`,
  };
}

export function typedSelectColumns(model: PublishedModel, alias = "m"): string {
  return physicalPlanFor(model).columns
    .map((column) => `${alias}.${identifier(column.fieldKey)} AS ${identifier(fieldAlias(column.fieldKey))}`)
    .join(",");
}

function encodedValue(field: FieldDefinition, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (field.type === "boolean") return value ? 1 : 0;
  return value;
}

function decodedValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (field.type === "boolean") {
    if (value !== 0 && value !== 1) throw new ApiError("RESOURCE_STORAGE_CORRUPT", "Stored boolean is invalid", 500);
    return value === 1;
  }
  return value;
}

function rangeComponents(mapping: PhysicalFieldMapping): {
  start: string;
  end: string;
} {
  const start = mapping.columns.find((column) => column.component === "start")?.fieldKey;
  const end = mapping.columns.find((column) => column.component === "end")?.fieldKey;
  if (!start || !end) {
    throw new ApiError(
      "INVALID_PHYSICAL_SCHEMA",
      `Range field ${mapping.fieldKey} has an incomplete physical mapping`,
      500,
    );
  }
  return { start, end };
}

function temporalComponents(mapping: PhysicalFieldMapping): {
  kind: string;
  start: string;
  end: string;
} {
  const kind = mapping.columns.find((column) => column.component === "kind")?.fieldKey;
  const start = mapping.columns.find((column) => column.component === "start")?.fieldKey;
  const end = mapping.columns.find((column) => column.component === "end")?.fieldKey;
  if (!kind || !start || !end) {
    throw new ApiError(
      "INVALID_PHYSICAL_SCHEMA",
      `Temporal range field ${mapping.fieldKey} has an incomplete physical mapping`,
      500,
    );
  }
  return { kind, start, end };
}

export function dehydrateTypedResourceData(
  model: PublishedModel,
  data: JsonObject,
): JsonObject {
  const stored: JsonObject = {};
  for (const mapping of physicalPlanFor(model).fieldMappings) {
    if (mapping.storage === "relation") continue;
    const field = model.definition.fields[mapping.fieldKey];
    const value = data[mapping.fieldKey];
    if (mapping.storage === "scalar") {
      const column = mapping.columns[0];
      if (!column) {
        throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Scalar field ${mapping.fieldKey} has no physical column`, 500);
      }
      stored[column.fieldKey] = encodedValue(field, value);
      continue;
    }

    if (mapping.storage === "range") {
      const columns = rangeComponents(mapping);
      if (value === undefined || value === null) {
        stored[columns.start] = null;
        stored[columns.end] = null;
        continue;
      }
      if (!isFirstClassRangeFieldType(field.type)) {
        throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Field ${mapping.fieldKey} has invalid range storage type`, 500);
      }
      const result = validateRangeValue(value, rangeFieldValueType(field.type));
      if (!result.valid) {
        throw new ApiError(
          "INVALID_RESOURCE",
          `${mapping.fieldKey} is invalid: ${result.issues.map((entry) => entry.message).join("; ")}`,
          400,
        );
      }
      stored[columns.start] = result.value.start;
      stored[columns.end] = result.value.endExclusive;
      continue;
    }

    const columns = temporalComponents(mapping);
    if (value === undefined || value === null) {
      stored[columns.kind] = null;
      stored[columns.start] = null;
      stored[columns.end] = null;
      continue;
    }
    const result = validateTemporalRangeValue(value);
    if (!result.valid) {
      throw new ApiError(
        "INVALID_RESOURCE",
        `${mapping.fieldKey} is invalid: ${result.issues.map((entry) => entry.message).join("; ")}`,
        400,
      );
    }
    stored[columns.kind] = result.value.kind;
    stored[columns.start] = result.value.start;
    stored[columns.end] = result.value.endExclusive;
  }
  return stored;
}

export function hydrateTypedResourceData(
  model: PublishedModel,
  stored: JsonObject,
  recordId = "<unknown>",
): JsonObject {
  const data: JsonObject = {};
  for (const mapping of physicalPlanFor(model).fieldMappings) {
    if (mapping.storage === "relation") continue;
    const field = model.definition.fields[mapping.fieldKey];
    if (mapping.storage === "scalar") {
      const column = mapping.columns[0];
      if (!column) {
        throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Scalar field ${mapping.fieldKey} has no physical column`, 500);
      }
      const value = stored[column.fieldKey];
      if (value === null || value === undefined) {
        if (field.required) {
          throw new ApiError(
            "RESOURCE_STORAGE_CORRUPT",
            `Required field ${mapping.fieldKey} is missing from resource ${recordId}`,
            500,
          );
        }
        if (field.nullable) data[mapping.fieldKey] = null;
        continue;
      }
      data[mapping.fieldKey] = decodedValue(field, value);
      continue;
    }

    if (mapping.storage === "range") {
      const columns = rangeComponents(mapping);
      const start = stored[columns.start];
      const endExclusive = stored[columns.end];
      const values = [start, endExclusive];
      const absent = values.every((value) => value === null || value === undefined);
      if (absent) {
        if (field.required) {
          throw new ApiError(
            "RESOURCE_STORAGE_CORRUPT",
            `Required field ${mapping.fieldKey} is missing from resource ${recordId}`,
            500,
          );
        }
        if (field.nullable) data[mapping.fieldKey] = null;
        continue;
      }
      if (values.some((value) => value === null || value === undefined)) {
        throw new ApiError(
          "RESOURCE_STORAGE_CORRUPT",
          `Range field ${mapping.fieldKey} is partially stored for resource ${recordId}`,
          500,
        );
      }
      if (!isFirstClassRangeFieldType(field.type)) {
        throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Field ${mapping.fieldKey} has invalid range storage type`, 500);
      }
      const result = validateRangeValue({ start, endExclusive }, rangeFieldValueType(field.type));
      if (!result.valid) {
        throw new ApiError(
          "RESOURCE_STORAGE_CORRUPT",
          `Range field ${mapping.fieldKey} is invalid for resource ${recordId}`,
          500,
        );
      }
      data[mapping.fieldKey] = result.value;
      continue;
    }

    const columns = temporalComponents(mapping);
    const kind = stored[columns.kind];
    const start = stored[columns.start];
    const endExclusive = stored[columns.end];
    const values = [kind, start, endExclusive];
    const absent = values.every((value) => value === null || value === undefined);
    if (absent) {
      if (field.required) {
        throw new ApiError(
          "RESOURCE_STORAGE_CORRUPT",
          `Required field ${mapping.fieldKey} is missing from resource ${recordId}`,
          500,
        );
      }
      if (field.nullable) data[mapping.fieldKey] = null;
      continue;
    }
    if (values.some((value) => value === null || value === undefined)) {
      throw new ApiError(
        "RESOURCE_STORAGE_CORRUPT",
        `Temporal range field ${mapping.fieldKey} is partially stored for resource ${recordId}`,
        500,
      );
    }
    const result = validateTemporalRangeValue({ kind, start, endExclusive });
    if (!result.valid) {
      throw new ApiError(
        "RESOURCE_STORAGE_CORRUPT",
        `Temporal range field ${mapping.fieldKey} is invalid for resource ${recordId}`,
        500,
      );
    }
    data[mapping.fieldKey] = result.value;
  }
  return data;
}

export function typedInsertStatement(
  env: Bindings,
  model: PublishedModel,
  recordId: string,
  spaceId: string,
  data: JsonObject,
): D1PreparedStatement {
  const plan = physicalPlanFor(model);
  const columns = ["record_id", "space_id", ...plan.columns.map((column) => column.fieldKey)];
  const dehydrated = dehydrateTypedResourceData(model, data);
  const values: unknown[] = [
    recordId,
    spaceId,
    ...plan.columns.map((column) => dehydrated[column.fieldKey] ?? null),
  ];
  return env.DB.prepare(`INSERT INTO ${identifier(plan.tableName)}(${columns.map(identifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .bind(...values);
}

export function typedUpdateStatement(
  env: Bindings,
  model: PublishedModel,
  recordId: string,
  spaceId: string,
  data: JsonObject,
  mutationToken: string,
): D1PreparedStatement {
  const plan = physicalPlanFor(model);
  if (!plan.columns.length) {
    return env.DB.prepare(`UPDATE ${identifier(plan.tableName)} SET space_id=space_id
      WHERE record_id=? AND space_id=?
        AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)
      .bind(recordId, spaceId, recordId, mutationToken);
  }
  const dehydrated = dehydrateTypedResourceData(model, data);
  const values: unknown[] = [];
  const assignments = plan.columns.map((column) => {
    values.push(dehydrated[column.fieldKey] ?? null);
    return `${identifier(column.fieldKey)}=?`;
  });
  return env.DB.prepare(`UPDATE ${identifier(plan.tableName)} SET ${assignments.join(",")}
    WHERE record_id=? AND space_id=?
      AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)
    .bind(...values, recordId, spaceId, recordId, mutationToken);
}

function scalarData(model: PublishedModel, row: TypedResourceRow): JsonObject {
  const stored = Object.fromEntries(
    physicalPlanFor(model).columns.map((column) => [
      column.fieldKey,
      row[fieldAlias(column.fieldKey)],
    ]),
  );
  return hydrateTypedResourceData(model, stored, row.id);
}

export function resourcesFromRows(model: PublishedModel, rows: TypedResourceRow[]): TypedStoredResource[] {
  return rows.map((row) => {
    const audit = resourceAuditFromStorage(row);
    return {
      id: row.id,
      spaceId: row.space_id,
      modelKey: row.model_key,
      modelVersion: row.model_version,
      data: scalarData(model, row),
      ...(audit ? { audit } : {}),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function relationReadStatement(env: Bindings, recordIds: readonly string[]): D1PreparedStatement {
  return env.DB.prepare(`SELECT source_record_id,field_key,ordinal,target_person_id,target_record_id
    FROM resource_relations WHERE source_record_id IN (${recordIds.map(() => "?").join(",")}) ORDER BY source_record_id,field_key,ordinal`)
    .bind(...recordIds);
}

export function applyRelationRows(
  model: PublishedModel,
  resources: TypedStoredResource[],
  rows: readonly RelationRow[],
): void {
  const relationFields = physicalPlanFor(model).relationFields;
  if (!resources.length || !relationFields.length) return;

  const values = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const targetId = row.target_person_id ?? row.target_record_id;
    if (!targetId) throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Relation ${row.field_key} has no target`, 500);
    let fields = values.get(row.source_record_id);
    if (!fields) {
      fields = new Map();
      values.set(row.source_record_id, fields);
    }
    const targets = fields.get(row.field_key) ?? [];
    targets.push(targetId);
    fields.set(row.field_key, targets);
  }

  for (const resource of resources) {
    const fields = values.get(resource.id);
    for (const fieldKey of relationFields) {
      const field = model.definition.fields[fieldKey];
      const targets = fields?.get(fieldKey) ?? [];
      if (field.type === "person_list" || field.type === "record_list") {
        resource.data[fieldKey] = targets;
      } else if (targets.length) {
        resource.data[fieldKey] = targets[0];
      } else if (field.required) {
        throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Required relation ${fieldKey} is missing from resource ${resource.id}`, 500);
      } else if (field.nullable) {
        resource.data[fieldKey] = null;
      }
    }
  }
}

async function hydrateRelations(
  env: Bindings,
  model: PublishedModel,
  resources: TypedStoredResource[],
): Promise<void> {
  const relationFields = physicalPlanFor(model).relationFields;
  if (!resources.length || !relationFields.length) return;

  const ids = [...new Set(resources.map((resource) => resource.id))];
  const statements = chunkD1Values(ids).map((chunk) => relationReadStatement(env, chunk));
  const rows = await allD1Batched<RelationRow>(env.DB, statements);
  applyRelationRows(model, resources, rows);
}

export async function hydrateTypedResourceRows(
  env: Bindings,
  model: PublishedModel,
  rows: TypedResourceRow[],
): Promise<TypedStoredResource[]> {
  const resources = resourcesFromRows(model, rows);
  await hydrateRelations(env, model, resources);
  return resources;
}

export async function getTypedResource(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
): Promise<TypedStoredResource | null> {
  const scalarSelect = typedSelectColumns(model);
  const recordStatement = env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at,
      ${resourceAuditSelectColumns("r")}${scalarSelect ? `,${scalarSelect}` : ""}
    FROM resource_records r
    JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    ${resourceAuditJoins("r")}
    WHERE r.id=? AND r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL`)
    .bind(recordId, spaceId, model.key);
  if (!physicalPlanFor(model).relationFields.length) {
    const row = await recordStatement.first<TypedResourceRow>();
    if (!row) return null;
    return resourcesFromRows(model, [row])[0] ?? null;
  }

  const results = await env.DB.batch([recordStatement, relationReadStatement(env, [recordId])]);
  const row = (results[0]?.results as TypedResourceRow[] | undefined)?.[0] ?? null;
  if (!row) return null;
  const resources = resourcesFromRows(model, [row]);
  applyRelationRows(model, resources, (results[1]?.results ?? []) as RelationRow[]);
  return resources[0] ?? null;
}

export async function listTypedResources(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  limit: number,
): Promise<TypedStoredResource[]> {
  const scalarSelect = typedSelectColumns(model);
  const rows = await env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""}
    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.id DESC LIMIT ?`)
    .bind(spaceId, model.key, limit).all<TypedResourceRow>();
  return hydrateTypedResourceRows(env, model, rows.results);
}
