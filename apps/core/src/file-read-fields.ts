// File identity and transfer authority remain in the existing File API.
// This projection only identifies published native file fields eligible for
// explicit MCP file_read selection. It does not grant access to any bytes.
export function nativeFileReadFields(definition: unknown): string[] {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
  const value = definition as { origin?: unknown; fields?: unknown };
  if (value.origin === "external" || !value.fields || typeof value.fields !== "object"
    || Array.isArray(value.fields)) return [];
  return Object.entries(value.fields).filter(([key, field]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/u.test(key)
      || !field || typeof field !== "object" || Array.isArray(field)) return false;
    const type = (field as { type?: unknown }).type;
    return type === "file" || type === "file_list";
  }).map(([key]) => key).sort();
}
