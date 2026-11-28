# Client-side Field Encryption / 客户端字段加密

Status: **Implementation candidate / 实施候选** — #663. Not a published contract, not deployed. Until the validator, runtime, public contracts and tests converge, encrypted field declarations remain unsupported. This document does not override the current Model Definition v1 specification.

## 1. Accepted scope

- One password and independent randomly generated data encryption key (DEK) per source Space. The password-derived key encryption key (KEK) wraps the DEK; no server-side encryption or decryption and no plaintext key/password sent to the platform.
- Native Model Definition opts in using a proposed boolean `encrypted: true` for `string`, `text`, `file`, `file_list` only. Missing/false retains existing semantics. No record-level toggle, other logical types, External Models or `file_ref_list`.
- File / file_list encrypt each original binary payload separately; stable File IDs, list order, original filename, MIME, size, relationship and audit metadata remain visible. File content is never embedded in a Record.
- Core owns the Space key envelope and field policy, not a user's unlock state. Account is the Space self-service experience; applications decide unlock duration, page navigation and logout cleanup. SDK does not persist raw keys or plaintext.
- Space Owner initializes and changes the wrapping password. Members can use the same Space password. No password recovery, forced reset, DEK rotation, disable/decrypt migration or per-member cryptographic key distribution in v1.
- Ordinary fields remain usable without a key. Optional encrypted fields may remain absent/null under existing required/nullable semantics. Any non-null encrypted write requires an initialized key. No existing plaintext field may silently switch to encrypted or back.

## 2. Architecture and threat model

This is a Semantics / storage confidentiality mechanism over durable Shared World and Shared Knowledge; it supports Space Boundary, Durable Shared Reality, Bounded Authority and Governed Change. It is not a new top-level ontology, independent service, identity system or application-specific model. Source Space ownership and existing Principal / Actor / Application Context, Data Grant, Delegation, model policy, File transfer and audit rules remain authoritative.

Database/R2/backup disclosure or honest-but-curious servers must reveal no protected content without the password. Visible metadata, equality of File IDs, sizes, access patterns, record existence and nonencrypted fields are not hidden. This is not protection against malicious client code, compromised devices, weak-password offline guessing, data intentionally disclosed by a recipient, or a malicious writer uploading fabricated envelopes. Core can check shape and authorization, not authenticate the secret plaintext or prove it was encrypted correctly. AEAD verification belongs to the client. A revoked Grant blocks subsequent authorized access, not cached bytes or keys; changing the password only rewraps the same DEK and cannot revoke a previous holder of the key. Users must be warned of irreversible loss and the absence of key-compromise recovery in v1.

## 3. Proposed wire and key contract

Candidate cipher: AES-256-GCM with a fresh 96-bit CSPRNG nonce for every encryption (including each DEK wrap), 128-bit authentication tag, and domain-separated authenticated additional data (AAD). The client uses an audited crypto implementation, never custom cipher code. The DEK is 32 random bytes generated on the client; distinguish immutable DEK version from optimistic wrapping configuration revision. A password change creates a fresh KDF salt and wrapping nonce and changes only the wrapping revision. A key version is never reused for a different key. Do not reuse nonces or deterministically encrypt to enable query.

KDF candidate: Argon2id with stored salt, algorithm version and bounded memory/time/parallelism parameters; select the exact interoperable profile after browser/target-client benchmarks and security review. Do not silently downgrade to an alternate KDF. Strictly validate untrusted profile parameters before allocating memory; no remote fallback, password verifier or recoverable server copy. All crypto values have a versioned canonical representation; binary text uses canonical unpadded base64url.

Proposed Space encryption configuration representation (names and bounds finalized with OpenAPI implementation):

```json
{
  "keyVersion": 1,
  "revision": 1,
  "kdf": {"algorithm": "argon2id", "salt": "...", "memoryKiB": 65536, "iterations": 3, "parallelism": 1},
  "wrappedDek": {"algorithm": "A256GCM", "nonce": "...", "ciphertext": "..."}
}
```

Illustrative parameters only; not production configuration. The encrypted DEK includes the authentication tag. Wrapping AAD includes format/domain, source Space ID, key version and canonical KDF profile. There is no server-side unlock endpoint. Proposed control plane is ordinary Space self-service, not Console platform-admin and not Identity: read authorized wrapped metadata, initialize once, replace wrapping with expected revision. Only an active direct User Owner with the appropriate existing Space manage scope may initialize or replace. The client verifies the old password by unwrapping, then rewraps the same DEK. Core cannot independently prove the new wrapping contains the same DEK, so owner-controlled mutation remains a destructive-risk operation. Audit only nonsecret version/revision and actor evidence; never log wrapped key payloads, salts unnecessarily, passwords, raw keys or signed URLs.

Wrapped metadata must be obtainable by a direct User with current source Space data access, including a model-only Data Grant, without granting Space membership/detail/management access. Finalize a narrowly authorized model-bound projection or equivalent existing authority check for nonmembers; do not broaden `spaces:read` or grant hidden authority. Machine/Agent paths do not receive keys automatically; ordinary ciphertext CRUD remains bounded by existing model authority.

## 4. Model and record contract

Example proposed logical definition:

```json
{
  "documentNumber": {"type":"string","encrypted":true},
  "notes": {"type":"text","encrypted":true,"nullable":true},
  "attachments": {"type":"file_list","encrypted":true}
}
```

- Reject encryption metadata on all other types and External origin. Normalize absent/false compatibly without changing existing model schema hashes. Expose logical type, encryption flag, and exact wire schema in immutable mct, Runtime semantic Discovery and Generic Operation projection. Never manually edit generated artifacts.
- String/Text non-null wire value uses a strict versioned encrypted envelope with DEK version, nonce and ciphertext+tag (proposed compact string format to preserve typed TEXT storage). Reject unknown versions, malformed encodings, invalid nonce/tag lengths, oversized payload and plaintext downgrade. Never trim or normalize ciphertext as if it were plaintext. Client applies existing logical constraints before encrypting; server applies separately bounded wire constraints and cannot enforce plaintext length/content. Use bounded ciphertext storage and payload limits; account for base64/AEAD expansion.
- Domain-separated AAD must bind source Space, model and field. Existing create paths allocate `rec_*` inside Core (generic-resource.ts); finalize record binding design before freezing the v1 wire format. Either provide a safe immutable pre-encryption identity for Create/Batch or explicitly document the lack of within-field cross-record replay binding; do not pretend a server-assigned record ID is already known at encryption time. AEAD is not a substitute for record optimistic concurrency.
- Exclude encrypted fields from query/search/filter/sort/aggregation and indexes, including Canonical Query, legacy projections and reference labels/templates. Reject defaults, action/guard/policy/Capability field dependencies that require plaintext; existing identity and record access policy stays enforced. No silently incomplete query or server-side computed plaintext.
- Write validation applies to Create, Update, Bulk, Batch, actions, import, and every other mutation route. Required/nullability and current key initialization checked before persistence; changes to an already-published field's encryption state rejected in v1. Preserve unencrypted existing models and contract hashes. Never automatically migrate existing records or rewrite historical snapshots.
- Store only ciphertext in ordinary typed rows, audit/change history, outbox, cache, backup/export and any derived context. Eventing stays reference-only. Validation errors must contain static field/reason hints, never submitted contents. Existing consumers may retain opaque values or explicitly reject unsupported encrypted-field writes; adapters must not decrypt.

## 5. Native File contract

Current flow in `apps/core/src/file-routes.ts`: begin session -> presigned PUT to uploads/native -> verify object size/MIME -> promote to permanent R2 files -> publish File row -> separate record attachment. Download is authorized record-field-linked signed GET. Reuse this flow and its current authorization, original upload model ceiling, Principal/Actor/session binding, expiry, lifecycle and race protections.

- Extend session/ready File metadata with versioned encryption profile, keyVersion and separate original vs transmitted size/MIME. Preserve File ID/list logical schema. Encrypted bytes use an authenticated versioned binary format with fresh nonce, tag, and source Space/File identity AAD. The encrypted upload body is served as opaque binary (not executable original MIME); original metadata remains available to clients. Begin can preallocate File ID before client encryption; ensure exact encrypted-size calculation and return the immutable identity needed for AAD, or finalize an equivalent stable binding before implementation.
- Encrypt before PUT, never promote plain bytes into encrypted-field File records. Server validates transfer shape, encrypted-format metadata, size and header where applicable, not the AEAD tag. Encrypted ready File reference is legal only for encrypted Native file/file_list, same Space and correct key version; do not let ordinary files be attached to encrypted fields or encrypted files be used as ordinary public icons/previews. Existing File identity may be referenced by multiple permitted fields; no record-specific key.
- For each list item validate with set-wise existing File projection mechanism; no per-file/per-record database I/O. Finalize rechecks current field semantics and session ownership, no stale session bypass; maintain safe cleanup and no writable permanent URL.
- Signed GET returns ciphertext, original metadata and encryption format. Client verifies tag and expected AAD before using bytes. No server OCR/thumbnail/content indexing, plaintext hashes, public assets or automatic AI processing. Preview only after client decryption using bounded memory; large-file streaming/chunking requires an explicit authenticated format and is not silently inferred.
- Keep native existing unencrypted File behavior and all External Provider operations unchanged.

## 6. Implementation and release gates

1. Finish precise crypto byte format/KDF, authorization routes, compatibility and error codes; update normative DSL/collection specification, owning OpenAPI contracts, permissions and architecture in the same implementation PR. This candidate is not a second normative specification.
2. Space key migration and owner-only management, authorized key metadata projection, descriptor/validator/typed storage/runtime/contract/discovery changes. Tests for valid and denied paths, default/required/null, old model hashes, stale writes, query/guard/label rejection, history and reference-only event behavior.
3. Native encrypted File/file_list session/metadata/validation/download integration and race/cleanup tests; no External changes.
4. Client SDK and Account self-service; independent interoperability vectors, wrong password, tampering, wrong Space/field/File, nonce uniqueness, size bounds, password rewrap, logout memory cleanup; test real Web and target Mini Program constraints before claiming support.
5. Adapter checks including REST/MCP/n8n, no broadened authority, ciphertext-preserving projection, old-client explicit failure; local/CI build, typecheck, contract regeneration and D1 performance regression.
6. Staging E2E with synthetic data, inspect D1/R2/history/event/log absence of plaintext, confirm cross-Space denial and old clients; no production release until explicitly approved and verified. Do not activate existing production model fields as part of infrastructure rollout.

## Evidence and remaining implementation checks

Current main baseline `c7446080a155bf30ec52b59bb12c454102e3563e`: `model-definition.ts` has no encryption property; `model-contract.ts` generates schemas; `generic-resource.ts` normalizes strings, allocates record IDs, validates File projections; `file-routes.ts` validates expected_size/content_type and returns ready File metadata; `docs/model-definition-collection-types.md` defines native file/file_list and reference-only file_ref_list. Contract paths and actual runtime must be checked comprehensively before coding connected behavior. No code execution, schema migration or production behavior is changed by this document.
