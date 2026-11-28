import type { Bindings } from "./env";
import { parseEncryptedText } from "./field-encryption";
import { ApiError } from "./http";
import type { ModelDefinition, ModelValidationIssue } from "./model-definition";

const CLIENT_RECORD_ID = /^rec_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u;
type Data = Record<string, unknown>;

export function hasEncryptedText(definition: ModelDefinition): boolean {
  return Object.values(definition.fields).some(field => field.encrypted && (field.type === "string" || field.type === "text"));
}

export function hasEncryptedTextValue(definition: ModelDefinition, data: Data): boolean {
  return Object.entries(definition.fields).some(([key, field]) =>
    field.encrypted && (field.type === "string" || field.type === "text") && data[key] !== undefined && data[key] !== null);
}

/** ID is technical create metadata, never a business field or mutable property.
 * Client-generated UUIDv4 is only a candidate for models with encrypted text.
 * Registry still rejects encrypted models until all security gates pass.
 */
export function candidateCreateId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.prototype.hasOwnProperty.call(input, "id")) return undefined;
  const id = (input as Data).id;
  if (typeof id !== "string" || CLIENT_RECORD_ID.exec(id)?.[0] !== id) {
    throw new ApiError("INVALID_RESOURCE", "Encrypted create id must be a rec_ UUIDv4 without hyphens", 400);
  }
  return id;
}

/** The global record primary key remains the final insert-only collision guard.
 * No record existence lookup or disclosure is added, including other Spaces. */
export function isRecordIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*resource_records\.id(?:\b|$)/u.test(message);
}

export function recordIdentityConflict(): ApiError {
  return new ApiError("RECORD_ID_CONFLICT", "Record identity is unavailable", 409);
}

export function extractEncryptedCreateIdentity(definition: ModelDefinition, input: unknown): { recordId?: string; fields: unknown } {
  if (!hasEncryptedText(definition) || !input || typeof input !== "object" || Array.isArray(input)) return { fields: input };
  const id = candidateCreateId(input);
  if (id === undefined) return { fields: input };
  const { id: _technicalId, ...fields } = input as Data;
  return { recordId: id, fields };
}

export function encryptedCreateRecordId(definition: ModelDefinition, data: Data, requestedId?: string, reservedId?: string): string | undefined {
  if (requestedId !== undefined && (!hasEncryptedText(definition) || CLIENT_RECORD_ID.exec(requestedId)?.[0] !== requestedId)) {
    throw new ApiError("INVALID_RESOURCE", "Invalid encrypted create identity", 400);
  }
  if (hasEncryptedTextValue(definition, data) && !requestedId) {
    throw new ApiError("ENCRYPTED_RECORD_ID_REQUIRED", "An encrypted text create requires a client-generated record id", 400);
  }
  if (requestedId && reservedId && requestedId !== reservedId) {
    throw new ApiError("ENCRYPTED_RECORD_ID_CONFLICT", "Encrypted create identity differs from the allocated record id", 409);
  }
  return requestedId ?? reservedId;
}

/** Called only after ordinary mutation authority and before persistence. No
 * wrapped DEK is read. Empty optional fields incur no additional D1 query.
 * V1 has no reset/delete/rotation of initialized keys.
 */
export type SpaceKeyVersionReader = () => Promise<{ key_version: number } | null>;

/** One lazy lookup per authorized same-Space batch; never cached across requests.
 * V1 does not support key replacement or deletion. */
export function createSpaceKeyVersionReader(env: Bindings, spaceId: string): SpaceKeyVersionReader {
  let pending: ReturnType<SpaceKeyVersionReader> | undefined;
  return () => pending ??= env.DB.prepare(`SELECT e.key_version FROM space_encryption_configs e
    JOIN spaces s ON s.id=e.space_id AND s.deleted_at IS NULL WHERE e.space_id=?`)
    .bind(spaceId).first<{ key_version: number }>();
}

export async function requireCurrentEncryptedTextKey(env: Bindings, spaceId: string, definition: ModelDefinition, data: Data,
  readKey: SpaceKeyVersionReader = createSpaceKeyVersionReader(env, spaceId)): Promise<void> {
  const versions = new Set<number>();
  for (const [key, field] of Object.entries(definition.fields)) {
    if (!field.encrypted || data[key] === undefined || data[key] === null) continue;
    if (field.type !== "string" && field.type !== "text") {
      throw new ApiError("INVALID_RESOURCE", "Encrypted file values are not yet supported by the Runtime", 400);
    }
    const envelope = parseEncryptedText(data[key]);
    if (!envelope) throw new ApiError("INVALID_RESOURCE", "Invalid encrypted text envelope", 400);
    versions.add(envelope.keyVersion);
  }
  if (!versions.size) return;
  const row = await readKey();
  if (!row) throw new ApiError("SPACE_ENCRYPTION_NOT_INITIALIZED", "Space encryption is not initialized", 409);
  if (versions.size !== 1 || !versions.has(row.key_version)) {
    throw new ApiError("SPACE_ENCRYPTION_KEY_VERSION_MISMATCH", "Encrypted field key version is not current for this Space", 409);
  }
}

/** Existing field encryption semantics are immutable in v1. A removed encrypted
 * field is also rejected here; historical field reuse needs a separate review.
 */
export function validateFieldEncryptionTransition(current: ModelDefinition | null, next: ModelDefinition): ModelValidationIssue[] {
  if (!current) return [];
  const issues: ModelValidationIssue[] = [];
  for (const [key, oldField] of Object.entries(current.fields)) {
    const field = next.fields[key];
    if ((!field && oldField.encrypted) || (field && Boolean(oldField.encrypted) !== Boolean(field.encrypted))) {
      issues.push({ path: "fields."+key+".encrypted", code: "FIELD_ENCRYPTION_IMMUTABLE",
        message: "An existing field cannot change encryption state or remove an encrypted field in v1" });
    }
  }
  return issues;
}
