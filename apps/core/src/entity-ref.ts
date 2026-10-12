import { ApiError } from "./http";

export type EntityRef = { kind: "person"; personId: string } | { kind: "record"; modelKey: string; recordId: string };
export function parseEntityRef(raw: unknown): EntityRef {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if (value.kind === "person" && Object.keys(value).every(k => ["kind", "personId"].includes(k))
      && typeof value.personId === "string" && /^per_[A-Za-z0-9_-]+$/.test(value.personId)) return { kind: "person", personId: value.personId };
    if (value.kind === "record" && Object.keys(value).every(k => ["kind", "modelKey", "recordId"].includes(k))
      && typeof value.modelKey === "string" && /^[a-z][a-z0-9_]{1,62}$/.test(value.modelKey)
      && typeof value.recordId === "string" && /^rec_[A-Za-z0-9_-]+$/.test(value.recordId)) return { kind: "record", modelKey: value.modelKey, recordId: value.recordId };
  }
  throw new ApiError("INVALID_ENTITY_REF", "Entity reference requires a Person or native Record identity", 400);
}
export function entityRefSchema() {
  return { "x-lifespace-type": "entity_ref", oneOf: [
    { type: "object", additionalProperties: false, properties: { kind: { const: "person" }, personId: { type: "string", pattern: "^per_[A-Za-z0-9_-]+$" } }, required: ["kind", "personId"] },
    { type: "object", additionalProperties: false, properties: { kind: { const: "record" }, modelKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" }, recordId: { type: "string", pattern: "^rec_[A-Za-z0-9_-]+$" } }, required: ["kind", "modelKey", "recordId"] },
  ] };
}
