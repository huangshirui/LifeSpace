# Trusted Application Authentication

Status: **Trusted application exchange implemented in Identity 0.4.0; Cloudflare Access principal resolution/linking is planned and is not yet part of the deployed Identity OpenAPI**

Updated: 2026-08-22

## Purpose

Trusted LifeSpace application backends/BFFs authenticate to Identity with an application credential whose plaintext starts with `lsa_`.

This credential is a generic platform mechanism for an application-owned trusted backend that has already resolved its own application-specific external identity mapping.

Example implemented flow:

```text
Mini Program / application client
  -> application-owned backend resolves provider identity
  -> application mapping resolves provider identity -> LifeSpace usr_*
  -> trusted backend authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived RS256 app-scoped user token
  -> untrusted client or approved BFF path calls LifeSpace Core/Identity
```

For HomeMew, the target application-owned backend is a redesigned Cloudflare backend. The existing WeChat Cloud Function is **not** adapted as a temporary LifeSpace bridge.

The `lsa_*` credential is never exposed to Mini Program code, browser JavaScript, mobile clients, logs, documentation or ordinary user APIs.

It is different from an opaque `lsp_pat_*` Service API Token:

- `lsa_*` authenticates a registered **application backend** to Identity so it may create/resolve users and exchange an already-resolved `usr_*` for a short-lived user token;
- `lsp_pat_*` authenticates a **service principal** directly to Core under current Data Grants.

Cloudflare Access Web authentication is a separate platform-owned authentication mode. In the final architecture, the Web BFF does not own the Access-principal -> `usr_*` mapping. Instead, it presents the verified Access assertion through an approved Identity contract and Identity independently validates and resolves the platform principal.

## Trust boundary

A trusted application may assert a LifeSpace `user_id` only after authenticating with one of its active application credentials. Identity derives the application ID (`azp`) and scope ceiling from current server-side application state.

The client cannot choose another application ID and cannot request scopes outside the application's current `allowedScopes`.

Application-owned provider identifiers such as WeChat `openid` remain outside LifeSpace Identity.

Cloudflare Access platform principals are intentionally different from application-owned provider identifiers. Access is the shared, long-term Web authentication and SSO layer for LifeSpace Web applications, so the Access-principal -> `usr_*` mapping belongs to Identity. Identity still does not receive Google/Microsoft provider subjects or application-specific provider IDs.

A same-account Cloudflare Service Binding may be selected as transport between an application Worker and a LifeSpace Worker where appropriate, but transport topology is not itself application authorization. Any future Service-Binding-specific trust mechanism must preserve explicit application identity, scope ceilings and revocation semantics rather than relying on hostname or network location.

## Credential storage

Application credentials use the existing Identity D1 `application_credentials` table.

Requirements:

- plaintext format starts with `lsa_` and contains cryptographically random secret material;
- only SHA-256 hash and a non-secret suffix are persisted;
- plaintext is returned exactly once at credential creation;
- metadata APIs never return plaintext or hashes;
- multiple active credentials may overlap temporarily for zero-downtime deployment rotation;
- revocation is immediate for subsequent `/internal/*` authentication;
- credentials are environment-specific and must not be reused between staging and production.

## Platform-admin application lifecycle

Identity 0.4.0 exposes the following bootstrap-admin routes protected by `x-bootstrap-secret`:

```text
GET    /bootstrap/v1/applications/{applicationId}
PATCH  /bootstrap/v1/applications/{applicationId}
GET    /bootstrap/v1/applications/{applicationId}/credentials
POST   /bootstrap/v1/applications/{applicationId}/credentials
DELETE /bootstrap/v1/applications/{applicationId}/credentials/{credentialId}
```

The global bootstrap secret is a platform-administration credential only. It is not an application runtime credential and must never be copied into HomeMew/ALOHA application configuration.

Mutable application policy through the PATCH route is intentionally bounded to:

- display name;
- `allowedScopes` ceiling;
- user access-token TTL (300-3600 seconds);
- active/disabled status.

`clientType` and `trustedBackend` classification are not mutable through this endpoint.

## Rotation runbook

Application credential rotation uses overlap, never in-place secret replacement:

```text
1. Inspect current application metadata and credential suffixes.
2. POST a replacement credential.
3. Store the returned lsa_* immediately in the target backend secret store.
4. Deploy/restart the backend with the new credential.
5. Verify user creation/token exchange and Core authorization.
6. DELETE the old credential.
7. Verify the old credential now receives 401 and the new credential still works.
```

Do not revoke the old credential before the replacement backend deployment has been verified.

If a credential plaintext is lost before it is installed, create another replacement. Plaintext is never recoverable from Identity.

## Planned Cloudflare Access platform-principal contract

Status: **Planned architecture contract. Not implemented in Identity 0.4.0 and not present in `apps/identity/openapi.yaml` yet.**

This section defines the next Identity contract boundary for owner-controlled LifeSpace Web/PWA applications. Implementation must update persistence, runtime behavior, automated tests and `apps/identity/openapi.yaml` together before any endpoint described here is considered deployed.

### Authentication authority

Cloudflare Access remains the long-term Web authentication and SSO authority. Google OAuth, Microsoft OAuth, email OTP and future upstream Web login methods are configured in Access, not reimplemented by LifeSpace Identity.

Identity trusts only a fully verified Access application token. It must independently validate at least:

- JWT signature against the configured Access issuer's signing keys;
- `iss` against the environment's approved Access issuer/team domain;
- `exp` / token lifetime;
- `aud` against the registered audience of the calling LifeSpace Web application;
- the presence and validity of the Access `sub` used for principal resolution.

A BFF may also validate the token for its own perimeter/session handling, but Identity must not trust a BFF-supplied `sub`, email or `user_id` without the original verifiable Access assertion.

### Principal and application keys

User identity and application identity are separate:

```text
(iss, sub) -> LifeSpace user_id

aud -> registered LifeSpace application / azp
```

Rules:

- `(iss, sub)` is the Access platform-principal key.
- `sub` is never used directly as a LifeSpace `usr_*`.
- `aud` is never part of the user identity key.
- multiple Access audiences may resolve the same `(iss, sub)` to the same `usr_*`.
- one Access audience must be registered only to the intended LifeSpace application context in a given environment.
- the calling application's `lsa_*` credential and the Access audience must agree before Identity may issue that application's user credential.
- `email` is a non-authoritative snapshot/attribute. It may aid display, audit and recovery, but email equality alone must never merge accounts.

### Planned persistence

Use a dedicated Identity-owned platform concept, not a generic `external_identities` table:

```text
access_principals
  id
  issuer
  subject
  user_id
  email_snapshot
  status
  linked_at
  last_seen_at
  created_at
  updated_at

UNIQUE (issuer, subject)
INDEX  (user_id)
```

`user_id` is deliberately not unique. A LifeSpace user may link multiple Access principals, including principals produced by different verified email addresses.

Application-owned mappings such as HomeMew `openid -> usr_*` remain outside this table and outside Identity entirely.

### Planned normal Web exchange

The deployed `/internal/v1/tokens` endpoint continues to serve application-owned identity flows where the trusted backend has already resolved a `usr_*`.

The Access Web path requires a separate contract in which Identity derives the user from the verified assertion instead of accepting an asserted `user_id`.

Target semantics:

```text
POST /internal/v1/access/tokens
Authorization: application credential (lsa_*)
Body:
  accessAssertion: <Cloudflare Access JWT>
  requestedScopes: [...]

Identity:
  validate lsa_* -> calling application
  validate Access JWT signature / iss / exp / aud
  ensure aud is registered to the calling application
  resolve (iss, sub) -> usr_*
  apply application scope ceiling / user status / token TTL
  issue app-scoped LifeSpace user token
```

Expected outcomes:

- `200`: principal is linked and a short-lived app-scoped user token is issued;
- `401`: application credential or Access assertion is invalid;
- `403`: audience/application mismatch, disabled application/user, or requested scope is not allowed;
- `409 ACCESS_PRINCIPAL_UNLINKED`: assertion is valid but `(iss, sub)` is not linked to a LifeSpace user.

The exact path/name may change during implementation, but these trust and response semantics are normative for the design.

### Planned first-use resolution

An unknown Access principal must not automatically create a new `usr_*` merely because the mapping is absent. The Web product must explicitly choose one of two flows:

1. **Link existing LifeSpace account** — prove control of an existing `usr_*` and bind the Access principal to it.
2. **Create new LifeSpace account** — explicitly create a new `usr_*` and atomically bind the current verified Access principal.

This avoids duplicate users when one natural person authenticates through different Access principals, for example different Google- and Microsoft-backed email addresses.

### Planned link challenge

For an existing Mini Program user, the preferred Web-first linking flow is a one-time challenge:

```text
Web BFF
  -> verified but unlinked Access assertion
  -> Identity creates one-time Access link challenge

Existing authenticated Mini Program
  -> scans/opens challenge
  -> confirms with current LifeSpace user bearer token

Identity
  -> derives usr_* from the bearer token
  -> atomically binds challenge's (iss, sub) -> that usr_*
```

Target contract shape:

```text
POST /internal/v1/access/link-challenges
  application credential + Access assertion
  -> 201 { challengeId, expiresAt, ... }

POST /api/v1/me/access-link-challenges/{challengeId}/confirm
  user bearer token
  -> 204 / linked
```

Security invariants:

- challenge IDs/tokens are opaque, high-entropy and short-lived;
- a challenge is single-use;
- the challenge is bound to the verified `(iss, sub)` and intended application context;
- confirmation derives `usr_*` from the authenticated LifeSpace bearer token, never from a request body `userId`;
- linking is atomic and fails if the Access principal became linked concurrently to another user;
- Identity never receives the Mini Program `openid` during confirmation.

### Planned explicit new-user registration

Creating a new LifeSpace account from an unlinked Access principal must be an explicit user action and an atomic Identity operation. Do not implement it as independent `POST /internal/v1/users` followed by a best-effort mapping write that can leave an orphan/duplicate relationship.

The implementation may introduce a dedicated Access registration endpoint or another atomic transaction, but it must guarantee:

```text
verified unlinked (iss, sub)
  + explicit create-new-account action
  -> create usr_*
  + bind Access principal to that usr_*
  in one transaction
```

### Multiple Access principals and account linking

One LifeSpace user may own multiple Access principals:

```text
Google-backed Access principal -----+
                                     +--> usr_123
Microsoft-backed Access principal --+
```

Cloudflare may normalize different upstream providers that produce the same email to one Access user, but LifeSpace must not depend on this behavior. If Access produces a different `sub`, LifeSpace treats it as an unlinked principal until the user proves control of the existing LifeSpace account.

Do not automatically merge users by email, display name or other mutable claims.

User-facing listing/unlinking/recovery APIs are intentionally deferred until their recovery and lockout threat model is designed. In particular, Identity cannot assume an application-specific Mini Program mapping exists because those mappings are intentionally opaque to Identity.

### Web-first user later linking a Mini Program

If Web created `usr_123` first and HomeMew later authenticates `openid_X`, the ownership boundary is reversed only at the application layer:

```text
HomeMew verifies openid_X
  -> approved account-link proof resolves existing usr_123
  -> HomeMew stores openid_X -> usr_123
```

Identity does not persist `openid_X`. The application may use an Identity-issued proof/token as evidence of the target `usr_*`, but the provider mapping remains application-owned.

### Contract implementation gate

Before this planned contract is marked deployed:

1. Add repository-owned Identity migration(s) for Access-principal state and registered Access audiences.
2. Implement Access JWT verification with issuer/audience allowlists and key-rotation behavior.
3. Implement normal Access token exchange, unlinked-principal handling, atomic registration and one-time linking.
4. Add integration/security tests for signature/issuer/audience failures, audience/application mismatch, duplicate-link races, multiple principals per user, challenge expiry/single-use and email non-merging.
5. Update `apps/identity/openapi.yaml` and increment the Identity contract version.
6. Update generated/pinned downstream contract artifacts before applications depend on the new surface.
7. Prove staging flows with at least HomeMew Web + HomeMew Mini Program and a second Web application/audience before production rollout.

## HomeMew Integration Readiness

Identity 0.4.0 credential lifecycle is retained as a **generic LifeSpace platform capability**. It is not an instruction to retrofit the old HomeMew Mini Program login Cloud Function.

Before the `HomeMew Integration Ready` milestone, LifeSpace must decide and document the final trusted-backend path for the redesigned HomeMew Cloudflare backend, including whether it uses `lsa_*` directly over HTTP/service binding transport or a later explicitly approved same-account mechanism with equivalent identity, scope and revocation guarantees.

For Web, the final architecture decision is now explicit: HomeMew Web uses Cloudflare Access as the authentication/SSO layer and the planned Identity Access-principal contract for platform user resolution. HomeMew Web must not own its own Access-subject -> `usr_*` mapping.

The final HomeMew application policy must define only product-needed user-facing scopes, for example:

```text
profile:read
profile:write
spaces:read
spaces:write
spaces:manage
resources:read
resources:write
creation-drafts:read
creation-drafts:write
```

`models:manage` is a service-admin capability and must not be placed into ordinary HomeMew user tokens.

Core still intersects the resulting token scopes with current Space membership/Data Grants, Application × Model Access, published model access and model/Capability policy.

The exact HomeMew application credential and contract configuration is frozen at the `HomeMew Integration Ready` milestone, not during intermediate platform proving work.

## Verification

Identity integration tests for the deployed trusted-application capability must prove:

- application metadata can be inspected without revealing credentials;
- mutable policy changes affect subsequent exchanges through current application state;
- replacement `lsa_*` plaintext is returned once and only its hash is stored;
- metadata listing exposes suffix/status/timestamps but no plaintext/hash;
- old and new credentials both work during the overlap window;
- revoking the old credential makes it fail immediately while the replacement remains valid.

The planned Cloudflare Access integration adds the additional implementation gates defined above; those checks are not claimed as passing until the contract, persistence and runtime implementation land together.
