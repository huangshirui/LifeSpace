import type { ModelDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import {
  parseReferenceLabelTemplate,
  REFERENCE_LABEL_OUTPUT_MAX_LENGTH,
  type ReferenceLabelDefinition,
} from "./reference-label-syntax";
import { typedScalarExpression } from "./typed-resource-storage";

export type ReferenceLabelSemantic =
  | { mode: "id"; fallback: "id"; maxLength: number }
  | { mode: "field"; field: string; fallback: "id"; maxLength: number }
  | { mode: "template"; template: string; fields: string[]; fallback: "id"; maxLength: number };

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function scalarTextSql(model: PublishedModel, fieldKey: string, alias: string): string {
  const expression = typedScalarExpression(model, fieldKey, alias);
  const field = model.definition.fields[fieldKey];
  if (field.type === "boolean") {
    return `CASE WHEN ${expression} IS NULL THEN '' WHEN ${expression}=1 THEN 'true' ELSE 'false' END`;
  }
  return `COALESCE(CAST(${expression} AS TEXT),'')`;
}

function normalizedLabelSql(raw: string, hasValue: string, recordAlias: string): string {
  const trimmed = `TRIM(${raw})`;
  return `CASE WHEN (${hasValue}) AND LENGTH(${trimmed})>0 THEN SUBSTR(${trimmed},1,${REFERENCE_LABEL_OUTPUT_MAX_LENGTH}) ELSE ${recordAlias}.id END`;
}

export function referenceLabelSemantic(definition: ModelDefinition): ReferenceLabelSemantic {
  const label = definition.referenceLabel;
  if (!label) {
    return { mode: "id", fallback: "id", maxLength: REFERENCE_LABEL_OUTPUT_MAX_LENGTH };
  }
  if ("field" in label) {
    return {
      mode: "field",
      field: label.field,
      fallback: "id",
      maxLength: REFERENCE_LABEL_OUTPUT_MAX_LENGTH,
    };
  }
  const parsed = parseReferenceLabelTemplate(label.template);
  if (!parsed) throw new Error("Validated reference label template is invalid");
  return {
    mode: "template",
    template: label.template,
    fields: parsed.fields,
    fallback: "id",
    maxLength: REFERENCE_LABEL_OUTPUT_MAX_LENGTH,
  };
}

export function renderReferenceLabel(
  definition: ModelDefinition,
  recordId: string,
  data: Record<string, unknown>,
): string {
  const label = definition.referenceLabel;
  if (!label) return recordId;

  let raw: string;
  let hasValue = false;
  if ("field" in label) {
    const value = data[label.field];
    hasValue = value !== undefined && value !== null && String(value).trim().length > 0;
    raw = value === undefined || value === null ? "" : String(value);
  } else {
    const parsed = parseReferenceLabelTemplate(label.template);
    if (!parsed) throw new Error("Validated reference label template is invalid");
    raw = parsed.segments.map((segment) => {
      if (segment.kind === "literal") return segment.value;
      const value = data[segment.field];
      if (value !== undefined && value !== null && String(value).trim().length > 0) hasValue = true;
      return value === undefined || value === null ? "" : String(value);
    }).join("");
  }

  const normalized = raw.trim().slice(0, REFERENCE_LABEL_OUTPUT_MAX_LENGTH);
  return hasValue && normalized ? normalized : recordId;
}

export function referenceLabelSql(
  model: PublishedModel,
  recordAlias = "r",
  modelAlias = "m",
): string {
  const label: ReferenceLabelDefinition | undefined = model.definition.referenceLabel;
  if (!label) return `${recordAlias}.id`;

  if ("field" in label) {
    const value = scalarTextSql(model, label.field, modelAlias);
    return normalizedLabelSql(value, `LENGTH(TRIM(${value}))>0`, recordAlias);
  }

  const parsed = parseReferenceLabelTemplate(label.template);
  if (!parsed) throw new Error("Validated reference label template is invalid");
  const raw = parsed.segments.map((segment) => segment.kind === "literal"
    ? sqlString(segment.value)
    : scalarTextSql(model, segment.field, modelAlias)).join(" || ");
  const hasValue = parsed.fields
    .map((fieldKey) => {
      const value = scalarTextSql(model, fieldKey, modelAlias);
      return `LENGTH(TRIM(${value}))>0`;
    })
    .join(" OR ");
  return normalizedLabelSql(raw, hasValue || "0", recordAlias);
}
