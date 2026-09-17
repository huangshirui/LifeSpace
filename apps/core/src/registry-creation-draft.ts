import type { Bindings } from "./env";
import { ApiError } from "./http";
import { isFirstClassRangeFieldType, rangeFieldValueType, type FieldDefinition, type ModelDefaultValue } from "./model-definition";
import { listPublishedModels, type PublishedModel } from "./model-registry";
import { validateRangeValue } from "./range-value";
import { validateTemporalRangeValue } from "./temporal-range";
import { isRfc3339Instant } from "./time-semantics";

export type RegistryDraftWarningCode = "AMBIGUOUS_PERSON" | "UNRESOLVED_PERSON" | "INVALID_INFERRED_VALUE" | "UNSUPPORTED_DETAIL";
export type RegistryDraftWarning = { code: RegistryDraftWarningCode; field: string | null; message: string };
export type RegistryPersonRef = { ref: string; personId: string; name: string };
export type RegistryDraftModel = PublishedModel;
export type RegistryDraftResult =
  | { status: "choose_model"; candidateModels: string[] }
  | { status: "ready"; modelKey: string; modelVersion: number; draft: Record<string, unknown>; missingFields: string[]; warnings: RegistryDraftWarning[] };

const warningCodes: RegistryDraftWarningCode[] = ["AMBIGUOUS_PERSON", "UNRESOLVED_PERSON", "INVALID_INFERRED_VALUE", "UNSUPPORTED_DETAIL"];

function rank(access: string): number { return access === "manage" ? 3 : access === "write" ? 2 : 1; }

export async function listWritableCreationModels(env: Bindings, applicationId: string): Promise<RegistryDraftModel[]> {
  const models = await listPublishedModels(env);
  const rows = await env.DB.prepare("SELECT model_key,max_access FROM application_model_access WHERE application_id=?")
    .bind(applicationId).all<{ model_key: string; max_access: "read" | "write" | "manage" }>();
  const access = new Map(rows.results.map((row) => [row.model_key, row.max_access]));
  return models.filter((model) => model.definition.access.includes("write") && rank(access.get(model.key) ?? "") >= 2);
}

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

function aiFieldSchema(field: FieldDefinition): Record<string, unknown> {
  const description = field.description ? { description: field.description } : {};
  switch (field.type) {
    case "string":
    case "text": return nullable({ type: "string", ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }), ...description });
    case "integer": return nullable({ type: "integer", ...(field.minimum === undefined ? {} : { minimum: field.minimum }), ...(field.maximum === undefined ? {} : { maximum: field.maximum }), ...description });
    case "number": return nullable({ type: "number", ...(field.minimum === undefined ? {} : { minimum: field.minimum }), ...(field.maximum === undefined ? {} : { maximum: field.maximum }), ...description });
    case "boolean": return nullable({ type: "boolean", ...description });
    case "date": return nullable({ type: "string", format: "date", ...description });
    case "instant":
    case "datetime": return nullable({ type: "string", format: "date-time", ...description });
    case "range<date>": return nullable({
      type: "object",
      additionalProperties: false,
      required: ["start", "endExclusive"],
      properties: {
        start: { type: "string", format: "date" },
        endExclusive: { type: "string", format: "date" },
      },
      ...description,
    });
    case "range<instant>": return nullable({
      type: "object",
      additionalProperties: false,
      required: ["start", "endExclusive"],
      properties: {
        start: { type: "string", format: "date-time" },
        endExclusive: { type: "string", format: "date-time" },
      },
      ...description,
    });
    case "timezone": return nullable({ type: "string", ...description });
    case "enum": return nullable({ type: "string", enum: field.values ?? [], ...description });
    case "person": return nullable({ type: "string", description: `${field.description ?? "Person reference"}. Use only a supplied temporary person ref.` });
    case "person_list": return { type: "array", maxItems: 100, items: { type: "string" }, description: `${field.description ?? "People references"}. Use only supplied temporary person refs.` };
    case "record": return { type: "null", description: "Record relations are not inferred by Creation Draft v1." };
    case "record_list": return { type: "array", maxItems: 0, items: { type: "string" }, description: "Record relations are not inferred by Creation Draft v1." };
    case "temporal_range": return nullable({
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "date" },
            start: { type: "string", format: "date" },
            endExclusive: { type: "string", format: "date" },
          },
          required: ["kind", "start", "endExclusive"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "instant" },
            start: { type: "string", format: "date-time" },
            endExclusive: { type: "string", format: "date-time" },
          },
          required: ["kind", "start", "endExclusive"],
        },
      ],
      ...description,
    });
  }
}

function closed(required: string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required, properties };
}

function writableFields(model: PublishedModel) {
  return Object.entries(model.definition.fields).filter(([, field]) => !field.readOnly);
}

function defaultFor(model: PublishedModel, fieldKey: string): { present: false } | { present: true; value: ModelDefaultValue } {
  const defaults = model.definition.defaults ?? {};
  if (!Object.prototype.hasOwnProperty.call(defaults, fieldKey)) return { present: false };
  return { present: true, value: defaults[fieldKey]! };
}

export function creationDraftModelDescriptors(models: PublishedModel[]) {
  return models.map((model) => ({
    key: model.key,
    version: model.version,
    name: model.definition.display.singular,
    description: model.definition.description ?? `${model.definition.display.singular} LifeSpace record`,
    fields: writableFields(model).map(([key, field]) => {
      const fallback = defaultFor(model, key);
      return {
        key,
        type: field.type,
        required: field.required === true && !fallback.present,
        description: field.description ?? null,
        values: field.values ?? null,
        default: fallback.present ? fallback.value : null,
      };
    }),
  }));
}

export function buildRegistryCreationDraftSchema(models: PublishedModel[]) {
  if (!models.length) throw new ApiError("CREATION_DRAFT_NO_MODELS", "No writable models are available to this application", 403);
  const keys = models.map((model) => model.key);
  const warning = closed(["code", "field", "message"], {
    code: { type: "string", enum: warningCodes },
    field: nullable({ type: "string" }),
    message: { type: "string", minLength: 1, maxLength: 500 },
  });
  const ready = models.map((model) => {
    const fields = writableFields(model);
    return closed(["status", "modelKey", "draft", "missingFields", "warnings"], {
      status: { const: "ready" },
      modelKey: { const: model.key },
      draft: closed(fields.map(([key]) => key), Object.fromEntries(fields.map(([key, field]) => {
        const fallback = defaultFor(model, key);
        const schema = aiFieldSchema(field);
        return [key, fallback.present ? { ...schema, default: fallback.value } : schema];
      }))),
      missingFields: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string" } },
      warnings: { type: "array", maxItems: 32, items: warning },
    });
  });
  return {
    name: "lifespace_registry_creation_draft",
    strict: true,
    schema: closed(["result"], {
      result: {
        anyOf: [
          closed(["status", "candidateModels"], {
            status: { const: "choose_model" },
            candidateModels: { type: "array", minItems: 2, maxItems: Math.max(2, keys.length), uniqueItems: true, items: { type: "string", enum: keys } },
          }),
          ...ready,
        ],
      },
    }),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("AI_INVALID_RESPONSE", "AI response must be an object", 502);
  return value as Record<string, unknown>;
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validTimezone(value: string) { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0)); return true; } catch { return false; } }
function message(code: RegistryDraftWarningCode) {
  return code === "AMBIGUOUS_PERSON" ? "The referenced person is ambiguous."
    : code === "UNRESOLVED_PERSON" ? "The referenced person could not be resolved."
      : code === "INVALID_INFERRED_VALUE" ? "An invalid inferred value was discarded." : "An explicit detail could not be represented.";
}
function addWarning(warnings: RegistryDraftWarning[], code: RegistryDraftWarningCode, field: string | null) {
  warnings.push({ code, field, message: message(code) });
}
function resolvePerson(ref: unknown, field: string, people: RegistryPersonRef[], warnings: RegistryDraftWarning[]) {
  if (ref === null) return null;
  if (typeof ref !== "string") { addWarning(warnings, "INVALID_INFERRED_VALUE", field); return null; }
  const matches = people.filter((person) => person.ref === ref);
  if (matches.length === 1) return matches[0]!.personId;
  addWarning(warnings, matches.length > 1 ? "AMBIGUOUS_PERSON" : "UNRESOLVED_PERSON", field);
  return null;
}
function scalar(field: FieldDefinition, value: unknown, key: string, warnings: RegistryDraftWarning[]) {
  if (value === null) return null;
  if (field.type === "temporal_range") {
    const result = validateTemporalRangeValue(value);
    if (!result.valid) { addWarning(warnings, "INVALID_INFERRED_VALUE", key); return null; }
    return result.value;
  }
  let valid = true;
  if (field.type === "string" || field.type === "text") valid = typeof value === "string" && (field.maxLength === undefined || value.length <= field.maxLength);
  else if (field.type === "integer") valid = Number.isInteger(value);
  else if (field.type === "number") valid = typeof value === "number" && Number.isFinite(value);
  else if (field.type === "boolean") valid = typeof value === "boolean";
  else if (field.type === "date") valid = typeof value === "string" && validDate(value);
  else if (field.type === "instant" || field.type === "datetime") valid = isRfc3339Instant(value);
  else if (isFirstClassRangeFieldType(field.type)) {
    const range = validateRangeValue(value, rangeFieldValueType(field.type));
    if (!range.valid) { addWarning(warnings, "INVALID_INFERRED_VALUE", key); return null; }
    return range.value;
  }
  else if (field.type === "timezone") valid = typeof value === "string" && validTimezone(value);
  else if (field.type === "enum") valid = typeof value === "string" && Boolean(field.values?.includes(value));
  if (valid && typeof value === "number") {
    valid = (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  }
  if (!valid) { addWarning(warnings, "INVALID_INFERRED_VALUE", key); return null; }
  return value;
}

export function normalizeRegistryCreationDraft(
  input: unknown,
  options: { models: PublishedModel[]; people: RegistryPersonRef[]; targetModelKey?: string },
): RegistryDraftResult {
  const envelope = object(input);
  const models = new Map(options.models.map((model) => [model.key, model]));
  if (envelope.status === "choose_model") {
    if (options.targetModelKey || !Array.isArray(envelope.candidateModels)) throw new ApiError("AI_INVALID_RESPONSE", "Invalid model-choice response", 502);
    const candidates = [...new Set(envelope.candidateModels.filter((value): value is string => typeof value === "string"))];
    if (candidates.length < 2 || candidates.some((key) => !models.has(key))) throw new ApiError("AI_INVALID_RESPONSE", "Invalid model-choice candidates", 502);
    return { status: "choose_model", candidateModels: candidates };
  }
  if (envelope.status !== "ready" || typeof envelope.modelKey !== "string") throw new ApiError("AI_INVALID_RESPONSE", "Invalid ready response", 502);
  const model = models.get(envelope.modelKey);
  if (!model || (options.targetModelKey && options.targetModelKey !== model.key)) throw new ApiError("AI_INVALID_RESPONSE", "AI selected an unavailable model", 502);
  const raw = object(envelope.draft);
  const warnings: RegistryDraftWarning[] = Array.isArray(envelope.warnings)
    ? envelope.warnings.flatMap((value) => {
      const item = object(value);
      return warningCodes.includes(item.code as RegistryDraftWarningCode) && typeof item.message === "string"
        ? [{ code: item.code as RegistryDraftWarningCode, field: typeof item.field === "string" ? item.field : null, message: item.message }]
        : [];
    }).slice(0, 32)
    : [];
  const missing = new Set(Array.isArray(envelope.missingFields) ? envelope.missingFields.filter((value): value is string => typeof value === "string") : []);
  const draft: Record<string, unknown> = {};
  for (const [key, field] of writableFields(model)) {
    const value = raw[key];
    if (field.type === "person") draft[key] = resolvePerson(value, key, options.people, warnings);
    else if (field.type === "person_list") {
      const refs = Array.isArray(value) ? value : [];
      draft[key] = [...new Set(refs.map((ref) => resolvePerson(ref, key, options.people, warnings)).filter((id): id is string => Boolean(id)))];
    } else if (field.type === "record") draft[key] = null;
    else if (field.type === "record_list") draft[key] = [];
    else draft[key] = scalar(field, value, key, warnings);

    const fallback = defaultFor(model, key);
    const empty = draft[key] === null || draft[key] === undefined || (Array.isArray(draft[key]) && draft[key].length === 0);
    if (empty && fallback.present) {
      draft[key] = structuredClone(fallback.value);
      missing.delete(key);
    } else if (field.required && empty) {
      missing.add(key);
    } else if (!empty) {
      missing.delete(key);
    }
  }
  return { status: "ready", modelKey: model.key, modelVersion: model.version, draft, missingFields: [...missing].slice(0, 100), warnings: warnings.slice(0, 32) };
}
