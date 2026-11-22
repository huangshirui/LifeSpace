import type { ExternalModel } from "./external-model";

// File identity and transfer authority remain in the existing File API.
// Capability fields are derived from published Native definitions or current
// External Provider snapshots; they do not grant access to any bytes.
export function nativeFileReadFields(definition: unknown): string[] {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
  const value = definition as { origin?: unknown; fields?: unknown };
  if (value.origin === "external" || !value.fields || typeof value.fields !== "object"
    || Array.isArray(value.fields)) return [];
  return Object.entries(value.fields).filter(([key, field]) => {
    if (!/^[a-z][A-Za-z0-9]{0,62}$/u.test(key)
      || !field || typeof field !== "object" || Array.isArray(field)) return false;
    const type = (field as { type?: unknown }).type;
    return type === "file" || type === "file_list";
  }).map(([key]) => key).sort();
}

// Upload uses the same published native field eligibility and excludes read-only fields.
export function nativeFileUploadFields(definition: unknown): string[] {
  const keys = nativeFileReadFields(definition);
  if (!keys.length) return [];
  const fields = (definition as { fields: Record<string, { readOnly?: unknown }> }).fields;
  return keys.filter(key => fields[key]?.readOnly !== true);
}

// Space-bound External upload is governed by the current Provider snapshot.
// Download is deliberately not inferred: Provider file references are not Core files.
export function externalFileUploadFields(model: ExternalModel): string[] {
  if (model.status !== "active" || model.declared_access !== "write") return [];
  return model.snapshot.fields
    .filter(field => field.type === "file_ref_list" && field.upload?.supported === true
      && field.writable === true && field.readOnly !== true)
    .map(field => field.key).sort();
}

