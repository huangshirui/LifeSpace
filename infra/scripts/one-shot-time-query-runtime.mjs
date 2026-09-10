import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const path = resolve(root, "apps/core/src/generic-query.ts");
let text = await readFile(path, "utf8");

function replaceOnce(before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  text = text.slice(0, first) + after + text.slice(first + before.length);
}

replaceOnce(
  'import type { PublishedModel } from "./model-registry";\n',
  'import type { PublishedModel } from "./model-registry";\nimport {\n  genericComparisonFieldSemantics,\n  isGenericComparableFieldType,\n  type GenericComparisonOperator,\n  type GenericComparisonValueType,\n  type GenericComparisonFieldSemantic,\n} from "./query-semantics";\nimport { localDateWindowToInstantRange } from "./time-semantics";\n',
  "query semantic imports",
);

replaceOnce(
`function rangeValue(field: FieldDefinition, raw: string, key: string): string | number {
  if (field.type === "date") return exactDate(raw, key);
  if (field.type === "datetime") return dateTime(raw, key);
  if (field.type === "integer" || field.type === "number") return scalarValue(field, raw, key);
  throw new ApiError("INVALID_QUERY", \`${key} is not supported for \${field.type}\`, 400);
}
`,
`function comparisonValue(type: GenericComparisonValueType, raw: string, key: string): string | number {
  if (type === "date") return exactDate(raw, key);
  if (type === "datetime") return dateTime(raw, key);
  if (type === "integer") {
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new ApiError("INVALID_QUERY", \`${key} must be an integer\`, 400);
    return value;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ApiError("INVALID_QUERY", \`${key} must be a number\`, 400);
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
`,
  "comparison value helpers",
);

replaceOnce(
`function allowedQueryKeys(model: PublishedModel): Set<string> {
  const allowed = new Set(["q", "sort", "cursor", "limit"]);
  for (const fieldKey of model.definition.query?.filterable ?? []) {
    allowed.add(fieldKey);
    const field = model.definition.fields[fieldKey];
    if (field && ["date", "datetime", "integer", "number"].includes(field.type)) {
      allowed.add(\`${fieldKey}From\`);
      allowed.add(\`${fieldKey}To\`);
    }
  }
  return allowed;
}
`,
`function allowedQueryKeys(model: PublishedModel): Set<string> {
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
`,
  "allowed generic query keys",
);

const oldFilterLoop = `  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field) continue;
    const exact = one(params, fieldKey);
    if (exact !== undefined) {
      if (field.type === "person" || field.type === "person_list") {
        sql += \` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='person' AND rel.target_person_id=?)\`;
        args.push(fieldKey, scalarValue(field, exact, fieldKey));
      } else if (field.type === "record" || field.type === "record_list") {
        sql += \` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='record' AND rel.target_record_id=?)\`;
        args.push(fieldKey, scalarValue(field, exact, fieldKey));
      } else if (field.type === "enum" && exact.includes(",")) {
        const values = exact.split(",").filter(Boolean);
        if (!values.length || new Set(values).size !== values.length) throw new ApiError("INVALID_QUERY", \`${fieldKey} enum filter is invalid\`, 400);
        const parsed = values.map((value) => scalarValue(field, value, fieldKey));
        sql += \` AND \${typedScalarExpression(model, fieldKey)} IN (\${parsed.map(() => "?").join(",")})\`;
        args.push(...parsed);
      } else {
        sql += \` AND \${typedScalarExpression(model, fieldKey)}=?\`;
        args.push(scalarValue(field, exact, fieldKey));
      }
    }

    const from = one(params, \`${fieldKey}From\`);
    const to = one(params, \`${fieldKey}To\`);
    if (from !== undefined) {
      if (["person", "person_list", "record", "record_list"].includes(field.type)) throw new ApiError("INVALID_QUERY", \`${fieldKey}From is not supported for relation fields\`, 400);
      sql += \` AND \${typedScalarExpression(model, fieldKey)}>=?\`;
      args.push(rangeValue(field, from, \`${fieldKey}From\`));
    }
    if (to !== undefined) {
      if (["person", "person_list", "record", "record_list"].includes(field.type)) throw new ApiError("INVALID_QUERY", \`${fieldKey}To is not supported for relation fields\`, 400);
      sql += \` AND \${typedScalarExpression(model, fieldKey)}<=?\`;
      args.push(rangeValue(field, to, \`${fieldKey}To\`));
    }
  }
`;

const newFilterLoop = `  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    const expression = comparisonExpression(model, semantic);
    const suppliedOperators = new Map<GenericComparisonOperator, string>();
    for (const transport of semantic.operators) {
      const raw = one(params, transport.parameter);
      if (raw === undefined) continue;
      const previous = suppliedOperators.get(transport.operator);
      if (previous) {
        throw new ApiError(
          "INVALID_QUERY",
          \`\${previous} and \${transport.parameter} are aliases for the same \${transport.operator} operator\`,
          400,
        );
      }
      suppliedOperators.set(transport.operator, transport.parameter);
      sql += \` AND \${expression}\${comparisonSqlOperator(transport.operator)}?\`;
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
          \`\${semantic.field} local-date window requires dateStart, dateEndExclusive, and timezone together\`,
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
          sql += \` AND \${expression}>=? AND \${expression}<?\`;
          args.push(instantRange.startInclusive, instantRange.endExclusive);
        } catch (error) {
          throw new ApiError(
            "INVALID_QUERY",
            error instanceof Error ? \`\${semantic.field} local-date window is invalid: \${error.message}\` : \`\${semantic.field} local-date window is invalid\`,
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
      sql += \` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='person' AND rel.target_person_id=?)\`;
      args.push(fieldKey, scalarValue(field, exact, fieldKey));
    } else if (field.type === "record" || field.type === "record_list") {
      sql += \` AND EXISTS(SELECT 1 FROM resource_relations rel WHERE rel.source_record_id=r.id AND rel.field_key=? AND rel.target_type='record' AND rel.target_record_id=?)\`;
      args.push(fieldKey, scalarValue(field, exact, fieldKey));
    } else if (field.type === "enum" && exact.includes(",")) {
      const values = exact.split(",").filter(Boolean);
      if (!values.length || new Set(values).size !== values.length) throw new ApiError("INVALID_QUERY", \`${fieldKey} enum filter is invalid\`, 400);
      const parsed = values.map((value) => scalarValue(field, value, fieldKey));
      sql += \` AND \${typedScalarExpression(model, fieldKey)} IN (\${parsed.map(() => "?").join(",")})\`;
      args.push(...parsed);
    } else {
      sql += \` AND \${typedScalarExpression(model, fieldKey)}=?\`;
      args.push(scalarValue(field, exact, fieldKey));
    }
  }
`;
replaceOnce(oldFilterLoop, newFilterLoop, "generic filter execution");

await writeFile(path, text, "utf8");
console.log("Generic Time Query runtime migration applied.");
