import type { Bindings } from "./env";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import { ApiError } from "./http";
import type { FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import {
  compilePhysicalSchema,
  type PhysicalFieldMapping,
  type PhysicalSchemaPlan,
} from "./physical-schema";
import { validateTemporalRangeValue } from "./temporal-range";
import {
  provenanceFromStorage,
  type InformationProvenance,
  type StoredProvenanceColumns,
} from "./resource-provenance";

type JsonObject = Record<string, unknown>;

export type TypedResourceRow = StoredProvenanceColumns & {
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
  provenance?: InformationProvenance;
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

function resourcesFromRows(model: PublishedModel, rows: TypedResourceRow[]): TypedStoredResource[] {
  return rows.map((row) => {
    const provenance = provenanceFromStorage(row);
    return {
      id: row.id,
      spaceId: row.space_id,
      modelKey: row.model_key,
      modelVersion: row.model_version,
      data: scalarData(model, row),
      ...(provenance ? { provenance } : {}),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

async function hydrateRelations(
  env: Bindings,
  model: PublishedModel,
  resources: TypedStoredResource[],
): Promise<void> {
  const relationFields = physicalPlanFor(model).relationFields;
  if (!resources.length || !relationFields.length) return;

  const ids = [...new Set(resources.map((resource) => resource.id))];
  const statements = chunkD1Values(ids).map((chunk) => env.DB.prepare(`SELECT source_record_id,field_key,ordinal,target_person_id,target_record_id
    FROM resource_relations WHERE source_record_id IN (${chunk.map(() => "?").join(",")}) ORDER BY source_record_id,field_key,ordinal`)
    .bind(...chunk));
  const rows = await allD1Batched<RelationRow>(env.DB, statements);

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
  const row = await env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at,
      p.source AS provenance_source,p.source_ref_json AS provenance_source_ref_json,
      p.derived_from_json AS provenance_derived_from_json${scalarSelect ? `,${scalarSelect}` : ""}
    FROM resource_records r
    JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    LEFT JOIN resource_provenance p ON p.record_id=r.id AND p.record_version=(
      SELECT MAX(p2.record_version) FROM resource_provenance p2
      WHERE p2.record_id=r.id AND p2.record_version<=r.version
    )
    WHERE r.id=? AND r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL`)
    .bind(recordId, spaceId, model.key).first<TypedResourceRow>();
  if (!row) return null;
  return (await hydrateTypedResourceRows(env, model, [row]))[0] ?? null;
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
