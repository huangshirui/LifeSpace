import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";

/** Candidate v1 profile, pending target-client benchmark. No password processing
 * occurs in Core. Do not register public routes until the contract is reviewed.
 */
export const SPACE_KDF_PROFILE = Object.freeze({
  algorithm: "argon2id",
  version: 19,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
} as const);
const MAX_REVISION = 0xffffffff;

export type SpaceKeyEnvelope = {
  keyVersion: 1;
  kdf: typeof SPACE_KDF_PROFILE & { salt: string };
  wrappedDek: { algorithm: "A256GCM"; nonce: string; ciphertext: string };
};
export type SpaceEncryptionConfig = SpaceKeyEnvelope & { revision: number };

type Row = { key_version: number; revision: number; kdf_salt: string; wrap_nonce: string; wrapped_dek: string };

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalBytes(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return decoded.length === length && btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") === value;
  } catch { return false; }
}

function invalid(): never {
  throw new ApiError("VALIDATION_ERROR", "Invalid Space encryption key envelope", 422);
}

/** Rebuild an exact object rather than persisting client-supplied arbitrary JSON.
 * Format validation cannot prove that a client wrapped the correct DEK.
 */
export function parseSpaceKeyEnvelope(input: unknown): SpaceKeyEnvelope {
  if (!exactObject(input, ["keyVersion", "kdf", "wrappedDek"]) || input.keyVersion !== 1) return invalid();
  const kdf = input.kdf;
  const wrap = input.wrappedDek;
  if (!exactObject(kdf, [...Object.keys(SPACE_KDF_PROFILE), "salt"])
    || Object.entries(SPACE_KDF_PROFILE).some(([key, value]) => kdf[key] !== value)
    || !canonicalBytes(kdf.salt, 16)) return invalid();
  if (!exactObject(wrap, ["algorithm", "nonce", "ciphertext"]) || wrap.algorithm !== "A256GCM"
    || !canonicalBytes(wrap.nonce, 12) || !canonicalBytes(wrap.ciphertext, 48)) return invalid();
  return {
    keyVersion: 1,
    kdf: { ...SPACE_KDF_PROFILE, salt: kdf.salt },
    wrappedDek: { algorithm: "A256GCM", nonce: wrap.nonce, ciphertext: wrap.ciphertext },
  };
}

export function spaceKeyWrapAad(spaceId: string, envelope: SpaceKeyEnvelope): Uint8Array {
  if (typeof spaceId !== "string" || spaceId.length === 0 || spaceId.length > 256) throw new TypeError("Invalid Space identity");
  const value = parseSpaceKeyEnvelope(envelope);
  const k = value.kdf;
  return new TextEncoder().encode(JSON.stringify(["LifeSpace", "wrap", 1, value.keyVersion, spaceId,
    k.algorithm, k.version, k.memoryKiB, k.iterations, k.parallelism, k.salt]));
}

function directUser(principal: Principal, scope: string): void {
  if (principal.type !== "user" || principal.actor || principal.purpose || principal.oauthExecution || !principal.scopes.includes(scope)) {
    throw new ApiError("FORBIDDEN", "Direct User authority is required for Space encryption", 403);
  }
}

const OWNER_EXISTS = `EXISTS (
  SELECT 1 FROM spaces s JOIN space_memberships m ON m.space_id=s.id
  WHERE s.id=? AND s.deleted_at IS NULL AND m.user_id=? AND m.deleted_at IS NULL AND m.role='owner'
)`;

async function requireOwner(env: Bindings, principal: Principal, spaceId: string): Promise<void> {
  directUser(principal, "spaces:manage");
  if (await requireSpacePermission(env, principal, spaceId, "manage") !== "owner") {
    throw new ApiError("SPACE_OWNER_REQUIRED", "Only the current Space owner can manage encryption", 403);
  }
}

function stored(row: Row): SpaceEncryptionConfig {
  try {
    if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > MAX_REVISION) throw new Error();
    return { ...parseSpaceKeyEnvelope({
      keyVersion: row.key_version,
      kdf: { ...SPACE_KDF_PROFILE, salt: row.kdf_salt },
      wrappedDek: { algorithm: "A256GCM", nonce: row.wrap_nonce, ciphertext: row.wrapped_dek },
    }), revision: row.revision };
  } catch {
    throw new ApiError("SPACE_ENCRYPTION_INVALID_STATE", "Stored Space encryption configuration is invalid", 500);
  }
}

/** Space-wide permission surface only. Model-only Grant projection belongs to
 * the ordinary model authority path; do not elevate that Grant to spaces:read.
 */
export async function readSpaceEncryption(env: Bindings, principal: Principal, spaceId: string): Promise<SpaceEncryptionConfig | null> {
  directUser(principal, "spaces:read");
  await requireSpacePermission(env, principal, spaceId, "read");
  const row = await env.DB.prepare(`SELECT e.key_version,e.revision,e.kdf_salt,e.wrap_nonce,e.wrapped_dek
    FROM space_encryption_configs e JOIN spaces s ON s.id=e.space_id AND s.deleted_at IS NULL
    WHERE e.space_id=?`).bind(spaceId).first<Row>();
  return row ? stored(row) : null;
}

/** Authorization is rechecked in the atomic SQL mutation, not only in JS.
 * Triggers insert metadata-only audit evidence in the same transaction.
 */
export async function initializeSpaceEncryption(env: Bindings, principal: Principal, spaceId: string, input: unknown): Promise<SpaceEncryptionConfig> {
  await requireOwner(env, principal, spaceId);
  const value = parseSpaceKeyEnvelope(input);
  let changed: number | undefined;
  try {
    const result = await env.DB.prepare(`INSERT INTO space_encryption_configs(
      space_id,key_version,revision,kdf_salt,wrap_nonce,wrapped_dek,updated_by_user_id,application_id,updated_at)
      SELECT ?,1,1,?,?,?,?,?,? WHERE ${OWNER_EXISTS}
      ON CONFLICT(space_id) DO NOTHING`).bind(spaceId, value.kdf.salt, value.wrappedDek.nonce,
      value.wrappedDek.ciphertext, principal.id, principal.clientId, new Date().toISOString(), spaceId, principal.id).run();
    changed = result.meta.changes;
  } catch {
    throw new ApiError("SPACE_ENCRYPTION_WRITE_FAILED", "Space encryption configuration could not be saved", 500);
  }
  if (!changed) {
    await requireOwner(env, principal, spaceId);
    throw new ApiError("SPACE_ENCRYPTION_ALREADY_INITIALIZED", "Space encryption is already initialized", 409);
  }
  return { ...value, revision: 1 };
}

export async function rewrapSpaceEncryption(env: Bindings, principal: Principal, spaceId: string, expectedRevision: unknown, input: unknown): Promise<SpaceEncryptionConfig> {
  await requireOwner(env, principal, spaceId);
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= MAX_REVISION) {
    throw new ApiError("VALIDATION_ERROR", "Invalid Space encryption revision", 422);
  }
  const value = parseSpaceKeyEnvelope(input);
  let changed: number | undefined;
  try {
    const result = await env.DB.prepare(`UPDATE space_encryption_configs SET
      revision=revision+1,kdf_salt=?,wrap_nonce=?,wrapped_dek=?,updated_by_user_id=?,application_id=?,updated_at=?
      WHERE space_id=? AND revision=? AND key_version=1 AND kdf_salt<>? AND wrap_nonce<>? AND ${OWNER_EXISTS}`)
      .bind(value.kdf.salt, value.wrappedDek.nonce, value.wrappedDek.ciphertext, principal.id, principal.clientId,
        new Date().toISOString(), spaceId, expectedRevision, value.kdf.salt, value.wrappedDek.nonce, spaceId, principal.id).run();
    changed = result.meta.changes;
  } catch {
    throw new ApiError("SPACE_ENCRYPTION_WRITE_FAILED", "Space encryption configuration could not be saved", 500);
  }
  if (!changed) {
    await requireOwner(env, principal, spaceId);
    throw new ApiError("SPACE_ENCRYPTION_REVISION_CONFLICT", "Space encryption changed, is not initialized, or wrapping randomness was reused", 409);
  }
  return { ...value, revision: expectedRevision + 1 };
}
