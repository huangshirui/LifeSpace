# LifeSpace Console — Target Credential Reveal Boundary

Status: **accepted for Configuration & Publishing Center Slice C**

## Decision

LifeSpace Console may present the plaintext of a **newly created target Application credential or Service API Token** to the current human platform administrator only through a dedicated, isolated reveal document.

This is a narrow output boundary for credentials the operator is creating for another trusted backend/service. It is **not** permission to expose any credential used to authorize the Console itself.

The following remain strictly server-only and are never revealable:

- the Console `IDENTITY_APPLICATION_CREDENTIAL` / executor `lsa_*`;
- the Console Core executor `lsp_svc_*`;
- raw Cloudflare Access assertions;
- LifeSpace user bearer tokens;
- platform-admin actor proofs;
- bootstrap/break-glass secrets;
- signing keys or credential hashes.

Ordinary React/JavaScript responses also never receive target credential plaintext.

## Why this exception exists

Identity correctly returns newly created `lsa_*` and `lsp_svc_*` plaintext exactly once. A usable platform configuration center must let an authorized operator install that new target credential into the intended backend/integration without turning React, local storage, cookies, logs, audit or another database into a credential store.

A normal JSON `fetch()` response containing the secret is therefore rejected. A plaintext `HttpOnly` cookie is also rejected: JavaScript cannot read it, but it still places recoverable credential plaintext in browser cookie storage and sends it back over later requests.

## Accepted handoff

```text
same-origin guarded create mutation
-> Identity Platform Admin creates target credential
-> Console Configuration Center Worker receives one-time plaintext server-side
-> Worker AES-GCM seals a short-lived reveal envelope
-> JSON response contains only sanitized metadata + opaque reveal URL
-> operator opens reveal URL
-> Worker re-verifies current Access -> LifeSpace platform-admin authority
-> Worker decrypts envelope server-side
-> isolated no-script/no-store HTML displays the target credential
-> operator stores it in the target system
```

The implementation is intentionally consolidated in `apps/console/worker/configuration-center.ts`. There is no intermediate plaintext browser cookie and no separate secret-reveal persistence layer.

The sealed reveal ticket:

- contains ciphertext, never plaintext;
- expires after 60 seconds;
- is authenticated with AES-GCM;
- is environment-bound;
- uses key material derived from the server-only Console Identity executor credential;
- is useless after expiry or after the relevant Console executor credential changes;
- is never persisted by Console as authoritative state.

The reveal response requires:

- a currently valid Cloudflare Access assertion;
- successful LifeSpace user exchange;
- current platform-administrator authority and actor-proof issuance;
- `Cache-Control: no-store` / `Pragma: no-cache`;
- `Referrer-Policy: no-referrer`;
- same-origin resource/opener policy;
- CSP with `default-src 'none'` and `script-src 'none'`;
- no forms, frames, external resources or client-side clipboard code.

## Replay semantics

Identity still issues the credential plaintext once. The Console reveal envelope is deliberately **short-lived but stateless** in the MVP, so the same encrypted reveal URL can be reopened during its brief validity window after re-authentication.

Therefore Console must describe this as a **short-lived operator reveal**, not claim cryptographic globally-exactly-once display semantics.

If stronger exactly-once display is later required, add an explicit ephemeral server-side consumption primitive or an authoritative direct secret-install destination. Do not fake exactly-once semantics with browser cookies or long-lived Console persistence.

## Failure and recovery

If sealing or reveal fails after Identity created the target credential, plaintext is not recoverable from Identity. The operator must revoke that credential from its metadata entry and create a replacement.

No error path may fall back to returning plaintext in JSON, a cookie, logs, audit fields or query parameters.

## Verification

The Console check gate requires:

- static credential/reveal boundary guards;
- TypeScript and Vite build;
- `node --check` of the built Worker bundle so edge-parser failures are caught before Cloudflare deployment;
- staging lifecycle acceptance proving generated Application credential / Service API Token plaintext does not appear in metadata or platform-admin audit.

The first staging deployment attempt of Slice C exposed a Worker parser incompatibility that TypeScript/Vite alone had not caught. The implementation was then consolidated and built-Worker syntax validation became part of the normal Console check gate before the successful staging deployment.

## Architecture classification

This is primarily an **Authority + Experience** boundary for securely handing a newly issued target credential to a human operator. It is not durable LifeSpace Reality/Semantics and does not introduce a new credential source of truth.

Identity remains authoritative for credential lifecycle and stored hashes/metadata. Console remains a client/BFF and transient presentation boundary only.
