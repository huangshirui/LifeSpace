// File identity and transfer authority remain in the existing File API.
// This projection only identifies published native file fields eligible for
// explicit MCP file_read selection. It does not grant access to any bytes.
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
