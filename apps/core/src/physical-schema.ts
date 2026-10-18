import { ApiError } from "./http";
import { isFirstClassRangeFieldType, type FieldDefinition, type FieldType, type ModelDefinition } from "./model-definition";

export type PhysicalColumnComponent = "value" | "kind" | "start" | "end";

export type PhysicalColumn = {
  /** Physical D1 column name. Scalar mappings preserve the logical field key. */
  fieldKey: string;
  logicalFieldKey: string;
  component: PhysicalColumnComponent;
  logicalType: FieldType;
  sqlType: "TEXT" | "INTEGER" | "REAL";
  nullable: boolean;
  checkSql?: string;
};

export type PhysicalFieldMapping = {
  fieldKey: string;
  logicalType: FieldType;
  storage: "scalar" | "relation" | "range" | "temporal_range";
  columns: PhysicalColumn[];
};

export type PhysicalIndex = {
  name: string;
  /** Logical field identity that requested the index. */
  fieldKey: string;
  columnKeys: string[];
  unique: false;
};

export type PhysicalSchemaPlan = {
  modelKey: string;
  tableName: string;
  fieldMappings: PhysicalFieldMapping[];
  columns: PhysicalColumn[];
  relationFields: string[];
  indexes: PhysicalIndex[];
  createTableSql: string;
  createIndexSql: string[];
};

export type CompatiblePhysicalChangePlan = {
  tableName: string;
  addedMappings: PhysicalFieldMapping[];
  addedColumns: PhysicalColumn[];
  addedRelationFields: string[];
  addedIndexes: PhysicalIndex[];
  statements: string[];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RELATION_TYPES = new Set(["person", "person_list", "record", "record_list"]);
const JSON_ARRAY_TYPES = new Set(["enum_list", "file_list", "file_ref_list"]);

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

function scalarColumn(fieldKey: string, field: FieldDefinition): PhysicalColumn {
  const sqlType = field.type === "integer" || field.type === "boolean"
    ? "INTEGER"
    : field.type === "number"
      ? "REAL"
      : "TEXT";
  const nullable = field.required !== true;
  let checkSql: string | undefined;
  if (["recurrence_rule", "entity_ref"].includes(field.type)) {
    checkSql = `${identifier(fieldKey)} IS NULL OR (json_valid(${identifier(fieldKey)}) AND json_type(${identifier(fieldKey)})='object')`;
  } else if (JSON_ARRAY_TYPES.has(field.type)) {
    checkSql = `${identifier(fieldKey)} IS NULL OR (json_valid(${identifier(fieldKey)}) AND json_type(${identifier(fieldKey)})='array')`;
  } else if (field.type === "boolean") {
    checkSql = `${identifier(fieldKey)} IS NULL OR ${identifier(fieldKey)} IN (0,1)`;
  } else if (field.type === "enum" && field.values?.length) {
    checkSql = `${identifier(fieldKey)} IS NULL OR ${identifier(fieldKey)} IN (${field.values.map(literal).join(",")})`;
  }
  return {
    fieldKey,
    logicalFieldKey: fieldKey,
    component: "value",
    logicalType: field.type,
    sqlType,
    nullable,
    ...(checkSql ? { checkSql } : {}),
  };
}

function rangeMapping(fieldKey: string, field: FieldDefinition): PhysicalFieldMapping {
  const nullable = field.required !== true;
  const start = `__r_${fieldKey}_start`;
  const end = `__r_${fieldKey}_end`;
  const present = `${identifier(start)} IS NOT NULL AND ${identifier(end)} IS NOT NULL`;
  const absent = `${identifier(start)} IS NULL AND ${identifier(end)} IS NULL`;
  return {
    fieldKey,
    logicalType: field.type,
    storage: "range",
    columns: [
      {
        fieldKey: start,
        logicalFieldKey: fieldKey,
        component: "start",
        logicalType: field.type,
        sqlType: "TEXT",
        nullable,
      },
      {
        fieldKey: end,
        logicalFieldKey: fieldKey,
        component: "end",
        logicalType: field.type,
        sqlType: "TEXT",
        nullable,
        checkSql: `(${absent}) OR (${present} AND ${identifier(start)} < ${identifier(end)})`,
      },
    ],
  };
}

function temporalRangeMapping(fieldKey: string, field: FieldDefinition): PhysicalFieldMapping {
  const nullable = field.required !== true;
  const kind = `__tr_${fieldKey}_kind`;
  const start = `__tr_${fieldKey}_start`;
  const end = `__tr_${fieldKey}_end`;
  const present = `${identifier(kind)} IS NOT NULL AND ${identifier(start)} IS NOT NULL AND ${identifier(end)} IS NOT NULL`;
  const absent = `${identifier(kind)} IS NULL AND ${identifier(start)} IS NULL AND ${identifier(end)} IS NULL`;
  return {
    fieldKey,
    logicalType: field.type,
    storage: "temporal_range",
    columns: [
      {
        fieldKey: kind,
        logicalFieldKey: fieldKey,
        component: "kind",
        logicalType: field.type,
        sqlType: "TEXT",
        nullable,
        checkSql: `${identifier(kind)} IS NULL OR ${identifier(kind)} IN ('date','instant')`,
      },
      {
        fieldKey: start,
        logicalFieldKey: fieldKey,
        component: "start",
        logicalType: field.type,
        sqlType: "TEXT",
        nullable,
      },
      {
        fieldKey: end,
        logicalFieldKey: fieldKey,
        component: "end",
        logicalType: field.type,
        sqlType: "TEXT",
        nullable,
        checkSql: `(${absent}) OR (${present} AND ${identifier(start)} < ${identifier(end)})`,
      },
    ],
  };
}

function mappingFor(fieldKey: string, field: FieldDefinition): PhysicalFieldMapping {
  if (RELATION_TYPES.has(field.type)) {
    return {
      fieldKey,
      logicalType: field.type,
      storage: "relation",
      columns: [],
    };
  }
  if (isFirstClassRangeFieldType(field.type)) return rangeMapping(fieldKey, field);
  if (field.type === "temporal_range") return temporalRangeMapping(fieldKey, field);
  return {
    fieldKey,
    logicalType: field.type,
    storage: "scalar",
    columns: [scalarColumn(fieldKey, field)],
  };
}

function indexFor(tableName: string, mapping: PhysicalFieldMapping): PhysicalIndex | null {
  if (mapping.storage === "relation" || JSON_ARRAY_TYPES.has(mapping.logicalType)) return null;
  return {
    name: assertIdentifier(`idx_${tableName}_${mapping.fieldKey}`),
    fieldKey: mapping.fieldKey,
    columnKeys: mapping.columns.map((column) => column.fieldKey),
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
  const columns = index.columnKeys.map(identifier);
  return `CREATE INDEX ${identifier(index.name)} ON ${identifier(tableName)}(space_id,${columns.join(",")},record_id)`;
}

export function compilePhysicalSchema(definition: ModelDefinition): PhysicalSchemaPlan {
  const tableName = physicalTableName(definition.key);
  const fieldMappings = Object.entries(definition.fields).map(([fieldKey, field]) => {
    assertIdentifier(fieldKey);
    return mappingFor(fieldKey, field);
  });
  const columns = fieldMappings.flatMap((mapping) => mapping.columns);
  const duplicateColumn = columns.find((column, index) =>
    columns.findIndex((candidate) => candidate.fieldKey === column.fieldKey) !== index
  );
  if (duplicateColumn) {
    throw new ApiError(
      "INVALID_PHYSICAL_SCHEMA",
      `Physical column ${duplicateColumn.fieldKey} is produced by more than one logical field`,
      500,
    );
  }
  const relationFields = fieldMappings
    .filter((mapping) => mapping.storage === "relation")
    .map((mapping) => mapping.fieldKey)
    .sort();

  const indexedFieldKeys = new Set([
    ...(definition.query?.filterable ?? []),
    ...(definition.query?.sortable ?? []),
  ]);
  const mappingByField = new Map(fieldMappings.map((mapping) => [mapping.fieldKey, mapping]));
  const indexes = [...indexedFieldKeys]
    .sort()
    .flatMap((fieldKey) => {
      const mapping = mappingByField.get(fieldKey);
      if (!mapping) return [];
      const index = indexFor(tableName, mapping);
      return index ? [index] : [];
    });

  const columnSql = columns.map(renderColumn);
  const createTableSql = `CREATE TABLE ${identifier(tableName)} (\n  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,\n  space_id TEXT NOT NULL REFERENCES spaces(id),${columnSql.length ? `\n  ${columnSql.join(",\n  ")},` : ""}\n  UNIQUE(space_id,record_id)\n)`;
  const createIndexSql = indexes.map((index) => renderIndex(tableName, index));

  return {
    modelKey: definition.key,
    tableName,
    fieldMappings,
    columns,
    relationFields,
    indexes,
    createTableSql,
    createIndexSql,
  };
}

function sameColumn(left: PhysicalColumn, right: PhysicalColumn): boolean {
  return left.fieldKey === right.fieldKey
    && left.logicalFieldKey === right.logicalFieldKey
    && left.component === right.component
    && left.logicalType === right.logicalType
    && left.sqlType === right.sqlType
    && left.nullable === right.nullable
    && left.checkSql === right.checkSql;
}

function sameMapping(left: PhysicalFieldMapping, right: PhysicalFieldMapping): boolean {
  return left.fieldKey === right.fieldKey
    && left.logicalType === right.logicalType
    && left.storage === right.storage
    && left.columns.length === right.columns.length
    && left.columns.every((column, index) => sameColumn(column, right.columns[index]!));
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
  const beforeMappings = new Map(before.fieldMappings.map((mapping) => [mapping.fieldKey, mapping]));
  const afterMappings = new Map(after.fieldMappings.map((mapping) => [mapping.fieldKey, mapping]));

  for (const [fieldKey, mapping] of beforeMappings) {
    const nextMapping = afterMappings.get(fieldKey);
    if (!nextMapping || !sameMapping(mapping, nextMapping)) {
      throw new ApiError(
        "MODEL_PHYSICAL_MIGRATION_REQUIRED",
        `Field ${fieldKey} requires a destructive or data-rewriting physical migration`,
        409,
      );
    }
  }

  const addedMappings = after.fieldMappings.filter((mapping) => !beforeMappings.has(mapping.fieldKey));
  const addedColumns = addedMappings.flatMap((mapping) => mapping.columns);
  const unsafeRequired = addedColumns.find((column) => !column.nullable);
  if (unsafeRequired) {
    throw new ApiError(
      "MODEL_PHYSICAL_MIGRATION_REQUIRED",
      `Required field ${unsafeRequired.logicalFieldKey} needs an explicit backfill/default migration plan`,
      409,
    );
  }

  const beforeIndexNames = new Set(before.indexes.map((index) => index.name));
  const addedIndexes = after.indexes.filter((index) => !beforeIndexNames.has(index.name));
  const beforeRelations = new Set(before.relationFields);
  const addedRelationFields = after.relationFields.filter((fieldKey) => !beforeRelations.has(fieldKey));
  const statements = [
    ...addedColumns.map((column) => `ALTER TABLE ${identifier(after.tableName)} ADD COLUMN ${renderColumn(column)}`),
    ...addedIndexes.map((index) => renderIndex(after.tableName, index)),
  ];

  return {
    tableName: after.tableName,
    addedMappings,
    addedColumns,
    addedRelationFields,
    addedIndexes,
    statements,
  };
}
