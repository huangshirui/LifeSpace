import { ApiError } from "./http";
import type { ModelDefinition } from "./model-definition";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_RESOURCE", "Resource body must be an object", 400);
  return value as JsonObject;
}

export function applyModelDefaults(definition: ModelDefinition, input: unknown): JsonObject {
  const result = { ...object(input) };
  for (const [fieldKey, value] of Object.entries(definition.defaults ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(result, fieldKey)) result[fieldKey] = structuredClone(value);
  }
  return result;
}
