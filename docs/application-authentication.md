# Trusted Application Authentication

Status: **Identity 0.5.0 implements trusted application credentials plus Cloudflare Access principal verification, audience registration, exchange, explicit registration and one-time account linking. Repository CI is green; staging deployment/proof remains required before Web consumers depend on it.**

Updated: 2026-08-22

## Purpose

LifeSpace supports two deliberately different application authentication boundaries:

1. application-owned provider identity, where a trusted application backend has already resolved its own external identity to a LifeSpace `usr_*` and authenticates to Identity with a server-only `lsa_*` credential;
2. platform-owned Cloudflare Access identity for LifeSpace Web/PWA applications, where the trusted Web BFF forwards the original Access assertion and Identity independently verifies and resolves the platform principal.

These boundaries must not be collapsed into a generic external-identity table.

Application-owned identifiers such as HomeMew WeChat `openid` remain application-owned. Cloudflare Access `(iss, sub)` is a shared platform Web principal and is Identity-owned.

## Trusted application credentials

Trusted LifeSpace application backends/BFFs authenticate to Identity with an application credential whose plaintext starts with `lsa_`.

The credential is server-only. It must never be exposed to Mini Program code, browser JavaScript, mobile clients, logs, documentation or ordinary user APIs.

It is different from an opaque `lsp_pat_*` Service API Token:

- `lsa_*` authenticates a registered **application backend** to Identity;
- `lsp_pat_*` authenticates a **service principal** directly under current Data Grants.

For an application-owned provider identity, the flow remains:

```text
Application client
  -> application-owned trusted backend verifies provider identity
  -> application mapping resolves provider identity -> LifeSpace usr_*
  -> backend authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived RS256 app-scoped LifeSpace user token
```

For HomeMew Mini Program, WeChat `openid -> usr_*` remains in HomeMew's application layer. Identity never receives or persists the `openid`.

## Application trust boundary

A trusted application may assert an already-resolved LifeSpace `user_id` through `/internal/v1/tokens` only after authenticating with an active `lsa_*` application credential.

Identity derives the calling application (`azp`), scope ceiling and token TTL from current server-side application state. The caller cannot choose another application identity or request scopes outside the registered application's current `allowedScopes`.

Cloudflare Access Web identity uses a separate contract. A Web BFF may validate Access for its own perimeter/session handling, but LifeSpace Identity does not trust BFF-supplied `sub`, email or `user_id`. Identity requires and independently verifies the original Access assertion.

A same-account Cloudflare Service Binding may be used as transport where appropriate, but transport topology is not authorization. Explicit application identity, scope ceilings and revocation semantics remain mandatory.

## `lsa_*` credential storage and lifecycle

Application credentials use Identity D1 `application_credentials`.

Requirements:

- plaintext begins with `lsa_` and contains cryptographically random secret material;
- only SHA-256 hash and a non-secret suffix are persisted;
- plaintext is returned exactly once at credential creation;
- metadata APIs never return plaintext or hashes;
- multiple active credentials may overlap temporarily for zero-downtime rotation;
- revocation is immediate for subsequent `/internal/*` authentication;
- credentials are environment-specific and must not be reused across staging and production.

Identity 0.5.0 retains these bootstrap-admin routes protected by `x-bootstrap-secret`:

```text
GET    /bootstrap/v1/applications/{applicationId}
PATCH  /bootstrap/v1/applications/{applicationId}
GET    /bootstrap/v1/applications/{applicationId}/credentials
POST   /bootstrap/v1/applications/{applicationId}/credentials
DELETE /bootstrap/v1/applications/{applicationId}/credentials/{credentialId}
```

The global bootstrap secret is platform-administration authority only. It must never be copied into application runtime configuration.

Mutable application policy is limited to:

- display name;
- `allowedScopes` ceiling;
- user access-token TTL from 300 to 3600 seconds;
- active/disabled status.

`clientType` and `trustedBackend` are not mutable through the application PATCH route.

### Rotation runbook

```text
1. Inspect current application metadata and credential suffixes.
2. POST a replacement application credential.
3. Store the returned lsa_* immediately in the target backend secret store.
4. Deploy/restart the backend with the new credential.
5. Verify token exchange and Core authorization.
6. DELETE the old credential.
7. Verify the old credential now receives 401 and the new credential still works.
```

Do not revoke the old credential before the replacement backend deployment has been verified. If plaintext is lost before installation, create another replacement; Identity never recovers stored plaintext.

## Cloudflare Access platform identity

Cloudflare Access is the long-term authentication and SSO authority for LifeSpace Web/PWA applications. Google OAuth, Microsoft OAuth, email OTP and future upstream Web login methods are configured in Access rather than reimplemented by LifeSpace Identity.

Identity 0.5.0 owns the mapping from a verified Access platform principal to a LifeSpace user.

### Identity and application keys

User identity and application identity are separate:

```text
(iss, sub) -> LifeSpace user_id

aud -> registered LifeSpace application / azp
```

Normative rules:

- `(iss, sub)` is the Access platform-principal key;
- Access `sub` is never reused directly as a LifeSpace `usr_*`;
- `aud` identifies the protected Access application and is not part of the user identity key;
- multiple Access audiences can resolve the same `(iss, sub)` to the same `usr_*`;
- a given `(issuer, audience)` can be actively registered to only one LifeSpace application;
- the calling `lsa_*` application and matched Access audience must agree before token issuance;
- `email` is only a snapshot/attribute for display, audit or recovery UX and never causes account merging;
- one LifeSpace user may link multiple Access principals.

### Persistence

Identity schema v5 adds dedicated platform state:

```text
access_audiences
  id
  application_id
  issuer
  audience
  status
  created_at
  revoked_at
  UNIQUE (issuer, audience)

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

access_link_challenges
  id
  application_id
  issuer
  subject
  audience
  email_snapshot
  expires_at
  created_at
  consumed_at
  linked_user_id
```

`access_principals.user_id` is intentionally not unique because multiple verified Access principals may belong to one LifeSpace user.

Application-owned identifiers such as WeChat `openid` do not belong in any of these tables.

## Access JWT verification

Identity independently verifies each Access assertion before using any identity claim.

The configured environment issuer is authoritative. For the current AISR Cloudflare Zero Trust organization it is:

```text
https://aisronline.cloudflareaccess.com
```

The verifier:

- accepts only compact JWTs signed with RS256;
- requires a non-empty `kid` and verifies the signature using the configured issuer's `/cdn-cgi/access/certs` JWKS;
- compares `iss` exactly with the configured issuer before any signing-key network request;
- validates `exp` and bounded `nbf` / `iat` timing;
- requires a non-empty `sub`;
- accepts Access `aud` as a string or non-empty string array and later requires one audience to match the calling LifeSpace application;
- rejects non-application Access token `type` values when the claim is present;
- caches signing keys briefly by issuer and forces one JWKS refresh when an unknown `kid` is seen, covering normal Access key rotation.

The verifier uses Workers WebCrypto directly; no extra JWT dependency is required.

An unverified JWT `iss` never controls the JWKS fetch target.

## Access audience registration

Access application audiences are platform-admin configuration and are stored in Identity, not in each application repository as an authority source.

Identity 0.5.0 exposes:

```text
GET    /bootstrap/v1/applications/{applicationId}/access-audiences
POST   /bootstrap/v1/applications/{applicationId}/access-audiences
DELETE /bootstrap/v1/applications/{applicationId}/access-audiences/{audienceId}
```

Registration is allowed only for an active trusted LifeSpace application with `clientType=web`.

A registration binds the configured Access issuer plus one Access audience to exactly one LifeSpace application. Revocation prevents new exchanges and also invalidates unconsumed link challenges that depend on that audience.

## Normal Web principal exchange

```text
POST /internal/v1/access/tokens
Authorization: Bearer <lsa_* application credential>
Body:
  accessAssertion: <Cloudflare Access JWT>
  requestedScopes: [...]
```

Identity performs this sequence:

```text
validate lsa_* -> calling LifeSpace application
validate Access signature / configured iss / lifetime / sub
match one Access aud to an active audience registration for that application
resolve (iss, sub) -> usr_*
check principal + user status
intersect request with application scope ceiling
use application token TTL
issue app-scoped LifeSpace user token
```

Expected outcomes:

- `200`: linked principal; short-lived LifeSpace user token issued;
- `401`: application credential or Access assertion invalid;
- `403`: audience/application mismatch, disabled principal/user/application, or scope not allowed;
- `409 ACCESS_PRINCIPAL_UNLINKED`: Access assertion valid but principal not yet linked;
- `503`: Access signing keys temporarily unavailable.

The existing `/internal/v1/tokens` remains the path for application-owned provider mappings that already resolved a `usr_*`.

## First-use resolution

A verified unknown Access principal never silently creates a new LifeSpace user.

The Web product must explicitly choose one of two paths:

1. link the Access principal to an existing LifeSpace account after proof of control;
2. explicitly create a new LifeSpace account and atomically bind the current principal.

This prevents accidental duplicates or unsafe merges when a natural person authenticates with different Google/Microsoft-backed Access principals.

### Explicit new-user registration

```text
POST /internal/v1/access/registrations
Authorization: Bearer <lsa_* application credential>
Body:
  accessAssertion: <Cloudflare Access JWT>
  displayName: <explicit user choice>
  requestedScopes: [...]
```

Identity independently verifies the assertion and audience, requires the principal to be unlinked, then creates the `usr_*` and `(iss, sub)` mapping in one D1 batch. Concurrent attempts cannot leave a valid duplicated principal mapping or an independently committed user/mapping pair.

Email equality is never consulted to select an existing user.

### Link existing LifeSpace account

The Web side first requests a challenge:

```text
POST /internal/v1/access/link-challenges
Authorization: Bearer <lsa_* application credential>
Body:
  accessAssertion: <Cloudflare Access JWT>

-> 201 { challengeId, expiresAt }
```

The challenge is high-entropy, one-time, short-lived and bound to the verified `(iss, sub)`, the calling LifeSpace application and the matched Access audience.

An already authenticated LifeSpace client then proves control of the target account:

```text
POST /api/v1/me/access-link-challenges/{challengeId}/confirm
Authorization: Bearer <LifeSpace user token>

-> 204
```

Security invariants:

- confirmation derives `usr_*` only from the verified LifeSpace bearer token;
- no request-body `userId` is accepted;
- the Access assertion is not trusted from a client-supplied decoded claim;
- the challenge expires after ten minutes and is single-use;
- a revoked audience invalidates outstanding confirmation attempts;
- consuming the challenge and inserting the Access-principal mapping execute atomically;
- a concurrent successful link of the same `(iss, sub)` causes the losing transaction to fail rather than remap the principal;
- Identity never sees an application-owned Mini Program `openid` during the linking flow.

## Multiple Access principals

A single LifeSpace user can intentionally own multiple Access principals:

```text
Google-backed Access principal -----+
                                     +--> usr_123
Microsoft-backed Access principal --+
```

Cloudflare may normalize some upstream providers to the same Access user, but LifeSpace does not depend on that behavior. Whenever Access produces a distinct `sub`, LifeSpace treats it as a distinct unlinked principal until the user proves control of an existing LifeSpace account or explicitly creates a new account.

Automatic merge by email, display name or other mutable claim is forbidden.

User-facing principal listing, unlinking and account-recovery APIs remain deferred until their lockout/recovery threat model is designed.

## Web-first user later linking an application-owned identity

If Web created `usr_123` first and HomeMew later authenticates `openid_X`, the ownership boundary remains application-side:

```text
HomeMew verifies openid_X
  -> approved proof resolves existing usr_123
  -> HomeMew stores openid_X -> usr_123
```

Identity still does not persist `openid_X`. The application may use an Identity-issued proof/token as evidence of the target `usr_*`, but provider mapping ownership does not move into Identity.

## HomeMew integration boundary

HomeMew Mini Program keeps its application-owned WeChat mapping and existing `/internal/v1/tokens` exchange path.

HomeMew Web uses Cloudflare Access as authentication/SSO and the Identity Access-principal contract above. HomeMew Web must not create its own Access-subject -> `usr_*` database.

The Web BFF keeps its `lsa_*` credential server-side, obtains the Access assertion from the Cloudflare-protected request, and forwards the original assertion to Identity. The browser must not be allowed to choose a decoded Access `sub`, `email`, audience or target LifeSpace user.

The ordinary HomeMew user scope ceiling must contain only product-facing capabilities such as:

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

`models:manage` remains a service/platform-admin capability and must not be included in ordinary HomeMew user tokens.

Core remains authoritative for Space membership/Data Grants, Application × Model Access, published model access and model/capability policy.

## Verification and rollout gate

Repository implementation for Identity 0.5.0 must keep all of the following covered by automated checks:

- Access signature, issuer, expiry and signing-key rotation behavior;
- Access audience registration uniqueness and audience/application mismatch rejection;
- `(iss, sub)` as the only Access user mapping key;
- linked-principal normal exchange;
- explicit atomic new-user registration;
- same-email distinct `sub` values not being merged;
- multiple Access principals linking to one LifeSpace user;
- link challenge expiry and single-use;
- link confirmation deriving the target user from the LifeSpace bearer token;
- existing application credential replacement/revocation behavior remaining intact;
- Identity OpenAPI and downstream pinned contract versions moving together.

As of this repository change, migration v5, Identity contract 0.5.0, runtime implementation and automated CI checks are complete.

Before production rollout, staging must still prove:

1. migration v5 and Identity 0.5.0 deployment;
2. a real Cloudflare Access assertion against a registered HomeMew Web audience;
3. HomeMew Web exchange for an already linked user;
4. HomeMew Mini Program confirmation of a one-time link challenge;
5. a second Web application/audience proving that cross-application audience exchange is rejected while the same `(iss, sub)` may resolve to the same user after intentional linking;
6. no production LifeSpace or HomeMew traffic/data is modified during proving.
