import { ApiError } from "./http";
import type { FieldDefinition, ModelDefinition } from "./model-definition";

export type PhysicalColumn = {
  fieldKey: string;
  sqlType: "TEXT" | "INTEGER" | "REAL";
  nullable: boolean;
  checkSql?: string;
};

export type PhysicalIndex = {
  name: string;
  fieldKey: string;
  unique: false;
};

export type PhysicalSchemaPlan = {
  modelKey: string;
  tableName: string;
  columns: PhysicalColumn[];
  relationFields: string[];
  indexes: PhysicalIndex[];
  createTableSql: string;
  createIndexSql: string[];
};

export type CompatiblePhysicalChangePlan = {
  tableName: string;
  addedColumns: PhysicalColumn[];
  addedRelationFields: string[];
  addedIndexes: PhysicalIndex[];
  statements: string[];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RELATION_TYPES = new Set(["person", "person_list", "record", "record_list"]);

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new ApiError("INVALID_PHYSICAL_SCHEMA", `Unsafe physical identifier ${value}`, 500);
  }
  return value;
}

function identifier(value: string): string {
  return `"${assertIdentifier(value)}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function physicalTableName(modelKey: string): string {
  return assertIdentifier(`mdl_${modelKey}`);
}

function columnFor(fieldKey: string, field: FieldDefinition): PhysicalColumn | null {
  if (RELATION_TYPES.has(field.type)) return null;

  const sqlType = field.type === "integer" || field.type === "boolean"
    ? "INTEGER"
    : field.type === "number"
      ? "REAL"
      : "TEXT";
  const nullable = field.required !== true;
  let checkSql: string | undefined;
  if (field.type === "boolean") {
    checkSql = `${identifier(fieldKey)} IS NULL OR ${identifier(fieldKey)} IN (0,1)`;
  } else if (field.type === "enum" && field.values?.length) {
    checkSql = `${identifier(fieldKey)} IS NULL OR ${identifier(fieldKey)} IN (${field.values.map(literal).join(",")})`;
  }

  return { fieldKey, sqlType, nullable, ...(checkSql ? { checkSql } : {}) };
}

function indexFor(tableName: string, fieldKey: string): PhysicalIndex {
  return {
    name: assertIdentifier(`idx_${tableName}_${fieldKey}`),
    fieldKey,
    unique: false,
  };
}

function renderColumn(column: PhysicalColumn): string {
  const pieces = [identifier(column.fieldKey), column.sqlType];
  if (!column.nullable) pieces.push("NOT NULL");
  if (column.checkSql) pieces.push(`CHECK(${column.checkSql})`);
  return pieces.join(" ");
}

function renderIndex(tableName: string, index: PhysicalIndex): string {
  return `CREATE INDEX ${identifier(index.name)} ON ${identifier(tableName)}(space_id,${identifier(index.fieldKey)},record_id)`;
}

export function compilePhysicalSchema(definition: ModelDefinition): PhysicalSchemaPlan {
  const tableName = physicalTableName(definition.key);
  const columns: PhysicalColumn[] = [];
  const relationFields: string[] = [];

  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    assertIdentifier(fieldKey);
    const column = columnFor(fieldKey, field);
    if (column) columns.push(column);
    else relationFields.push(fieldKey);
  }

  const indexedFieldKeys = new Set([
    ...(definition.query?.filterable ?? []),
    ...(definition.query?.sortable ?? []),
  ]);
  const scalarColumnKeys = new Set(columns.map((column) => column.fieldKey));
  const indexes = [...indexedFieldKeys]
    .filter((fieldKey) => scalarColumnKeys.has(fieldKey))
    .sort()
    .map((fieldKey) => indexFor(tableName, fieldKey));

  const columnSql = columns.map(renderColumn);
  const createTableSql = `CREATE TABLE ${identifier(tableName)} (\n  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,\n  space_id TEXT NOT NULL REFERENCES spaces(id),${columnSql.length ? `\n  ${columnSql.join(",\n  ")},` : ""}\n  UNIQUE(space_id,record_id)\n)`;
  const createIndexSql = indexes.map((index) => renderIndex(tableName, index));

  return {
    modelKey: definition.key,
    tableName,
    columns,
    relationFields: relationFields.sort(),
    indexes,
    createTableSql,
    createIndexSql,
  };
}

function sameColumn(left: PhysicalColumn, right: PhysicalColumn): boolean {
  return left.sqlType === right.sqlType
    && left.nullable === right.nullable
    && left.checkSql === right.checkSql;
}

export function compileCompatiblePhysicalChange(
  previous: ModelDefinition,
  next: ModelDefinition,
): CompatiblePhysicalChangePlan {
  if (previous.key !== next.key) {
    throw new ApiError("MODEL_PHYSICAL_MIGRATION_REQUIRED", "A model key cannot change in-place", 409);
  }

  const before = compilePhysicalSchema(previous);
  const after = compilePhysicalSchema(next);
  const beforeColumns = new Map(before.columns.map((column) => [column.fieldKey, column]));
  const afterColumns = new Map(after.columns.map((column) => [column.fieldKey, column]));
  const beforeRelations = new Set(before.relationFields);
  const afterRelations = new Set(after.relationFields);

  for (const [fieldKey, column] of beforeColumns) {
    const nextColumn = afterColumns.get(fieldKey);
    if (!nextColumn || !sameColumn(column, nextColumn)) {
      throw new ApiError("MODEL_PHYSICAL_MIGRATION_REQUIRED", `Field ${fieldKey} requires a destructive or data-rewriting physical migration`, 409);
    }
  }
  for (const fieldKey of beforeRelations) {
    if (!afterRelations.has(fieldKey)) {
      throw new ApiError("MODEL_PHYSICAL_MIGRATION_REQUIRED", `Relation field ${fieldKey} cannot be removed by an additive publication`, 409);
    }
  }

  const addedColumns = after.columns.filter((column) => !beforeColumns.has(column.fieldKey));
  const unsafeRequired = addedColumns.find((column) => !column.nullable);
  if (unsafeRequired) {
    throw new ApiError(
      "MODEL_PHYSICAL_MIGRATION_REQUIRED",
      `Required field ${unsafeRequired.fieldKey} needs an explicit backfill/default migration plan`,
      409,
    );
  }

  const beforeIndexNames = new Set(before.indexes.map((index) => index.name));
  const addedIndexes = after.indexes.filter((index) => !beforeIndexNames.has(index.name));
  const addedRelationFields = after.relationFields.filter((fieldKey) => !beforeRelations.has(fieldKey));
  const statements = [
    ...addedColumns.map((column) => `ALTER TABLE ${identifier(after.tableName)} ADD COLUMN ${renderColumn(column)}`),
    ...addedIndexes.map((index) => renderIndex(after.tableName, index)),
  ];

  return {
    tableName: after.tableName,
    addedColumns,
    addedRelationFields,
    addedIndexes,
    statements,
  };
}
