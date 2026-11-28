/** Candidate Native field encryption wire codec. No database, keys or decryption.
 *  Not enabled in Model Definition until all runtime/contract gates are ready.
 */
export const ENCRYPTED_FIELD_TYPES = ["string", "text", "file", "file_list"] as const;
export const FIELD_WIRE_PREFIX = "lsenc1";
export const MAX_TEXT_PLAINTEXT_BYTES = 64 * 1024;
export const GCM_TAG_BYTES = 16;
export const GCM_NONCE_BYTES = 12;
const MAX_CIPHERTEXT_BYTES = MAX_TEXT_PLAINTEXT_BYTES + GCM_TAG_BYTES;
const MAX_CIPHERTEXT_CHARS = Math.ceil(MAX_CIPHERTEXT_BYTES * 4 / 3);
const UINT32_MAX = 0xffffffff;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SPACE_ID = /^spc_[a-f0-9]{32}$/u;
const RECORD_ID = /^rec_[a-f0-9]{32}$/u;
const FILE_ID = /^fil_[a-f0-9]{32}$/u;
const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/u;
const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,62}$/u;

export type EncryptedTextEnvelope = { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array };

export function supportsNativeFieldEncryption(type: unknown): boolean {
  return ENCRYPTED_FIELD_TYPES.some((allowed) => type === allowed);
}

export function isEncryptionKeyVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= UINT32_MAX;
}

function encodeBase64Url(bytes: Uint8Array): string {
  // Avoid spreading a potentially large array onto the JS call stack.
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(input: string, maxBytes: number): Uint8Array | null {
  if (!BASE64URL.test(input) || input.length > Math.ceil(maxBytes * 4 / 3) || input.length % 4 === 1) return null;
  try {
    const value = atob(input.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
    // Reject padded encodings, nonzero unused bits, whitespace and other aliases.
    return bytes.length <= maxBytes && encodeBase64Url(bytes) === input ? bytes : null;
  } catch { return null; }
}

/** Strict shape validation only. Authenticity is checked with the DEK on the client. */
export function parseEncryptedText(value: unknown): EncryptedTextEnvelope | null {
  if (typeof value !== "string" || value.length > FIELD_WIRE_PREFIX.length + 3 + 10 + 16 + MAX_CIPHERTEXT_CHARS) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== FIELD_WIRE_PREFIX || !/^[1-9][0-9]{0,9}$/u.test(parts[1])) return null;
  const keyVersion = Number(parts[1]);
  if (!isEncryptionKeyVersion(keyVersion) || String(keyVersion) !== parts[1]) return null;
  if (parts[2].length !== 16) return null;
  const nonce = decodeBase64Url(parts[2], GCM_NONCE_BYTES);
  const ciphertext = decodeBase64Url(parts[3], MAX_CIPHERTEXT_BYTES);
  if (!nonce || nonce.length !== GCM_NONCE_BYTES || !ciphertext || ciphertext.length < GCM_TAG_BYTES) return null;
  return { keyVersion, nonce, ciphertext };
}

export function encodeEncryptedText(value: EncryptedTextEnvelope): string {
  if (!isEncryptionKeyVersion(value.keyVersion) || !(value.nonce instanceof Uint8Array) || value.nonce.length !== GCM_NONCE_BYTES ||
      !(value.ciphertext instanceof Uint8Array) || value.ciphertext.length < GCM_TAG_BYTES || value.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new TypeError("Invalid encrypted text envelope");
  }
  return [FIELD_WIRE_PREFIX, String(value.keyVersion), encodeBase64Url(value.nonce), encodeBase64Url(value.ciphertext)].join(".");
}

function validIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

/** Stable canonical tuple encoded as UTF-8 JSON, not concatenated with a delimiter.
 * Record IDs must be allocated before encryption; the eventual Create contract
 * must verify the supplied ID. A record move/rekey requires client re-encryption.
 */
export function textFieldAad(spaceId: string, modelKey: string, recordId: string, fieldKey: string, keyVersion: number): Uint8Array {
  if (!validIdentifier(spaceId, SPACE_ID) || !validIdentifier(modelKey, MODEL_KEY) || !validIdentifier(recordId, RECORD_ID) || !validIdentifier(fieldKey, FIELD_KEY) || !isEncryptionKeyVersion(keyVersion)) {
    throw new TypeError("Invalid encrypted field context");
  }
  return new TextEncoder().encode(JSON.stringify(["LifeSpace", "field", 1, keyVersion, spaceId, modelKey, recordId, fieldKey]));
}

/** Stable File identity permits linking the same file to multiple authorized records. */
export function nativeFileAad(spaceId: string, fileId: string, keyVersion: number): Uint8Array {
  if (!validIdentifier(spaceId, SPACE_ID) || !validIdentifier(fileId, FILE_ID) || !isEncryptionKeyVersion(keyVersion)) throw new TypeError("Invalid encrypted file context");
  return new TextEncoder().encode(JSON.stringify(["LifeSpace", "file", 1, keyVersion, spaceId, fileId]));
}
