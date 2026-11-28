// LifeSpace client crypto foundation. No network, storage or password policy.
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function bytes(value, name, size) {
  if (!(value instanceof Uint8Array) || (size !== undefined && value.byteLength !== size)) {
    throw new TypeError(`${name} must be a Uint8Array${size === undefined ? '' : ` of ${size} bytes`}`);
  }
  return value;
}

function context(aad) {
  bytes(aad, 'AAD');
  if (aad.byteLength === 0) throw new TypeError('AAD must not be empty');
  return aad;
}

function aesKey(key, usage) {
  if (key?.type !== 'secret' || key.algorithm?.name !== 'AES-GCM' ||
      key.algorithm.length !== 256 || !key.usages?.includes(usage)) {
    throw new TypeError('Expected an AES-256-GCM key with the required usage');
  }
  return key;
}

export function generateDekBytes() {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export async function importAes256Key(raw) {
  return globalThis.crypto.subtle.importKey('raw', bytes(raw, 'key', KEY_BYTES),
    {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

// The caller supplies stable, domain-separated authenticated context bytes.
// This layer deliberately does not define a field or File wire format.
export async function encryptBytes(key, plaintext, aad) {
  aesKey(key, 'encrypt');
  bytes(plaintext, 'plaintext');
  context(aad);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8}, key, plaintext));
  return {nonce, ciphertext};
}

export async function decryptBytes(key, envelope, aad) {
  aesKey(key, 'decrypt');
  context(aad);
  const nonce = bytes(envelope?.nonce, 'nonce', NONCE_BYTES);
  const ciphertext = bytes(envelope?.ciphertext, 'ciphertext');
  if (ciphertext.byteLength < TAG_BYTES) throw new TypeError('Invalid ciphertext length');
  return new Uint8Array(await globalThis.crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8}, key, ciphertext));
}

export async function wrapDek(kek, rawDek, aad) {
  return encryptBytes(kek, bytes(rawDek, 'DEK', KEY_BYTES), aad);
}

// Return temporary raw DEK bytes only to the trusted caller. The caller must
// import/re-wrap the DEK and clear this array in a finally block. JS cannot
// guarantee erasure of all runtime copies; do not persist or log the bytes.
export async function unwrapDek(kek, envelope, aad) {
  if (envelope?.ciphertext?.byteLength !== KEY_BYTES + TAG_BYTES) {
    throw new TypeError('Invalid wrapped DEK length');
  }
  return decryptBytes(kek, envelope, aad);
}
