# Trusted Application and Web Authentication

## Status

- Cloudflare Access is the long-term Web/PWA authentication and SSO layer.
- Identity application/user/service contract is `0.6.0`; this revision adds a short opaque scan token as an alternate transport for the existing proof-backed Access account-link challenge.
- Identity Platform Admin companion contract `0.1.0` and the platform-administrator/purpose-bound actor foundation are merged on `main`.
- Access principal verification, audience registration, explicit registration/linking and trusted application credential lifecycle are implemented.
- `apps/console` now has the permanent React/Vite same-origin BFF shell on PR #47. The current UI slice is read-only except for staging-only first-use registration; final acceptance still requires real staging full-admin/browser E2E before any production rollout.

## Purpose

LifeSpace deliberately separates three authentication boundaries:

1. **application-owned provider identity** — the application resolves its own provider identifier to a LifeSpace `usr_*`, then its trusted backend authenticates to Identity with `lsa_*`;
2. **Cloudflare Access platform identity** — Identity independently verifies the raw Access assertion and owns `(iss, sub) -> usr_*` mapping for LifeSpace Web/PWA applications;
3. **platform administration** — a verified LifeSpace human actor and a separate controlled backend executor are both required for privileged Console operations.

These boundaries must not be collapsed into one generic external-identity or administrator-token model.

## Trusted application credential: `lsa_*`

A trusted LifeSpace application backend/BFF authenticates to Identity with a revocable server-only credential:

```text
lsa_<random-secret>
```

`lsa_*` represents a registered **application backend**. It is not:

- a user credential;
- a service principal credential for Core;
- a browser/session token;
- a platform bootstrap secret.

Plaintext is returned exactly once when a credential is created. Identity stores only its cryptographic hash and non-secret suffix/metadata. Multiple active credentials may overlap during zero-downtime rotation; revocation takes effect immediately on subsequent Identity authentication.

`lsa_*` must never appear in Mini Program code, browser JavaScript, mobile/downloadable clients, repository source, logs or documentation examples containing a real secret.

## Application-owned external identity

Application-specific provider identifiers remain in the owning application boundary.

Example: HomeMew Mini Program.

```text
WeChat server-side authentication
  -> HomeMew resolves openid
  -> HomeMew mapping resolves openid -> usr_123
  -> HomeMew backend authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived app-scoped LifeSpace user token
```

Identity never receives or persists the WeChat `openid`. The same ownership rule applies to WeCom IDs, school-system IDs and other application-specific subjects.

The application may assert an already-resolved LifeSpace user only after authenticating with an active trusted application credential. Identity derives `azp`, allowed scope ceiling and token TTL from current registered application state; the caller cannot choose another application or exceed that ceiling.

A Mini Program code, QR code, deep link or other application-specific launch mechanism is an **adapter/experience transport**, not a new LifeSpace identity. The owning application is responsible for its provider credentials, code generation and provider-subject resolution. LifeSpace owns only the durable proof/challenge and principal-link authority described below.

## Cloudflare Access platform identity

Cloudflare Access is intentionally different because it is shared across owner-controlled LifeSpace Web/PWA applications.

Cloudflare Access is responsible for:

- Google/Microsoft/email OTP or other configured upstream Web login methods;
- Web perimeter policy;
- Access SSO/session handling.

LifeSpace Identity is responsible for:

- independent RS256 verification of the raw Access JWT;
- exact configured issuer validation;
- signing-key/JWKS rotation handling;
- lifetime, subject and Access application-token type validation;
- mapping the verified Access platform principal to `usr_*`;
- binding a verified Access audience to the registered LifeSpace application context;
- explicit account registration/linking;
- issuing app-scoped LifeSpace credentials.

Identity is not a parallel Google/Microsoft/email IdP and does not persist their provider refresh tokens or provider subject IDs.

## Access identity and application keys

User identity and application identity are separate:

```text
(iss, sub) -> LifeSpace usr_*
(iss, aud) -> registered LifeSpace application / azp
```

Normative rules:

- `sub` is never reused as `usr_*`;
- `aud` identifies the protected Web application, not the human;
- one `(issuer, audience)` registration can belong actively to only one LifeSpace application;
- multiple audiences may still resolve the same `(iss, sub)` to the same `usr_*`;
- the calling `lsa_*` application and matched Access audience must agree;
- email is non-authoritative metadata and never auto-merges accounts;
- one `usr_*` may intentionally own multiple Access principals.

Identity persistence for Access platform identity uses dedicated `access_audiences`, `access_principals` and one-time `access_link_challenges` state. Application-owned provider IDs do not belong in those tables.

## Normal Web token exchange

A same-origin Web BFF keeps `lsa_*` server-side, obtains the original Access assertion from the Cloudflare-protected request and calls:

```text
POST /internal/v1/access/tokens
Authorization: Bearer <lsa_*>

{
  "accessAssertion": "<raw Access JWT>",
  "requestedScopes": [...]
}
```

Identity performs:

```text
validate lsa_* and calling application
validate Access signature / configured iss / lifetime / sub
match one aud to an active registration for the same application
resolve (iss, sub) -> usr_*
check user/principal/application state
intersect requested scopes with application ceiling
issue short-lived app-scoped LifeSpace user token
```

The BFF may perform its own perimeter/session validation, but BFF-supplied `sub`, email or `userId` is never accepted as Identity authority.

## First-use Access resolution

A valid but unknown Access principal does not silently create or merge a LifeSpace user.

At the platform level there are two explicit capabilities:

1. explicitly create a new `usr_*` and bind the verified principal where the application product policy allows registration;
2. prove control of an existing LifeSpace account and link the principal to that user.

An application may deliberately expose only the second capability. For example, HomeMew Web is existing-user-link-only and must not expose Access registration even though Identity retains the platform capability for other approved applications.

### Explicit registration

```text
POST /internal/v1/access/registrations
Authorization: Bearer <lsa_*>
```

Identity independently verifies the Access assertion/audience and atomically creates the LifeSpace user plus `(iss, sub)` mapping. Email equality is not consulted to select an existing user.

### Link existing account

The Web BFF first creates a short-lived challenge:

```text
POST /internal/v1/access/link-challenges
Authorization: Bearer <lsa_*>
```

Identity returns:

```text
challengeId = alc_<high-entropy long id>
scanToken   = als_<short opaque random token>
expiresAt   = <timestamp>
```

Both values refer to the same application/audience/Access-principal-bound challenge. The long `challengeId` remains a compatibility/debug transport. The short `scanToken` exists so an application adapter can fit the challenge into transports with strict payload limits, such as a WeChat Mini Program code `scene`.

The scan token is deliberately not another principal identifier:

- its plaintext is returned only to the trusted application backend/BFF that created the challenge;
- Identity persists only `SHA-256(scanToken)`;
- it is short-lived and one-time because the underlying challenge is short-lived and one-time;
- it contains no `usr_*`, Access `sub`, email, WeChat `openid` or provider credential;
- browser or Mini Program input can never use it to choose a target `usr_*`.

An application may transform the short token into its own launch transport. Example HomeMew flow:

```text
HomeMew Web BFF
  -> create LifeSpace link challenge
  -> receive server-only scanToken
  -> HomeMew backend uses its own WeChat AppID/AppSecret
  -> generate HomeMew Mini Program code with scene=<scanToken>
  -> browser receives only the rendered Mini Program code
  -> WeChat launches HomeMew
  -> HomeMew resolves its own openid -> usr_123
  -> user explicitly approves the link
  -> current LifeSpace user bearer confirms scanToken
```

The original long-ID confirmation remains:

```text
POST /api/v1/me/access-link-challenges/{challengeId}/confirm
Authorization: Bearer <LifeSpace user JWT>
```

The short-token confirmation is equivalent authority:

```text
POST /api/v1/me/access-link-scan-tokens/{scanToken}/confirm
Authorization: Bearer <LifeSpace user JWT>
```

In both cases the target `usr_*` is derived only from the verified LifeSpace bearer token. The challenge is high-entropy, application/audience/principal-bound, expires after ten minutes and is single-use. Consumption and principal-link insertion are atomic.

Scanning must not itself complete the link. The authenticator application must obtain an explicit user confirmation before submitting the LifeSpace confirmation request; this prevents an arbitrary displayed code from silently adding a login method to a user account.

This allows an existing HomeMew Mini Program user to link Web Access identity without exposing WeChat `openid` to Identity and without LifeSpace storing HomeMew's WeChat credentials.

## Link conflicts and multiple Access principals

LifeSpace explicitly supports:

```text
Access principal A ----+
                       +--> usr_123
Access principal B ----+
```

Therefore an existing HomeMew/LifeSpace user having already used a different email, Google login or other Cloudflare Access path is not itself a conflict. A newly verified, currently unlinked `(iss, sub)` may be explicitly added to the same `usr_123` after proof of control.

Conflict is defined by principal ownership, not email text:

```text
new Access principal is unlinked
  -> proof-backed LINK to usr_123 is allowed

Access principal already belongs to usr_123
  -> treat as already-linked/idempotent session state; do not create another user

Access principal already belongs to usr_456
  + a new proof attempts to link it to usr_123
  -> reject; never overwrite or transfer the principal implicitly
  -> explicit user-merge/recovery capability is required before reconciliation
```

Two outstanding challenges for the same unlinked Access principal do not weaken this rule. Whichever valid proof wins the atomic principal insertion establishes ownership; a later confirmation by another `usr_*` must fail and must not replace the first mapping.

Cloudflare may normalize some upstream identities itself, but LifeSpace does not depend on that behavior. A distinct verified Access `sub` remains unlinked until explicit proof succeeds.

Automatic merge by email, display name or other mutable claim is forbidden. A verified/contact email recorded by an application is not permission to manufacture an Access `(iss, sub)` mapping before that actual Access principal has been observed and verified.

## Platform-admin human proof

Cloudflare Access entry to `lifespace.aisr.online` is necessary but insufficient for LifeSpace platform administration.

Identity owns explicit `platform_administrators` assignments. Initial assignment/recovery is bootstrap-only.

A user must first have an ordinary short-lived LifeSpace user token for the Console application. A currently assigned administrator may then request:

```text
POST /api/v1/me/platform-admin-actor-token
Authorization: Bearer <ordinary Console LifeSpace user JWT>
```

Identity verifies:

- the user is active;
- a current `platform_administrators` assignment is active;
- the calling LifeSpace application is active;
- that application is allowed `platform:admin`.

It returns a dedicated proof with:

```text
principal_type = user
scope          = platform:admin
purpose        = platform_admin_actor
azp            = Console application
TTL            = 300 seconds
```

This actor proof is intentionally separate from ordinary product user tokens. Privileged endpoints receive it as:

```text
X-LifeSpace-Actor-Token: <purpose-bound JWT>
```

Raw `actorUserId`, Access email/sub, decoded claims or another unsigned header are forbidden substitutes.

## Platform-admin executor pairing

Privileged Console calls require a second credential held only by the same-origin BFF.

For Identity-owned administration:

```text
Authorization: Bearer <Console lsa_* executor>
X-LifeSpace-Actor-Token: <5-minute actor proof>
```

The executor must carry the operation-specific capability required by the route, for example:

```text
applications:manage
services:manage
identities:read
audit:read
```

Actor `azp` and executor application ID must match.

For Core-owned administration the same human proof is paired with a Core service executor, described in `docs/permissions.md` and `docs/service-authentication.md`.

## Platform-admin application management

Bootstrap application administration remains available for provisioning/break-glass, but normal Console runtime uses the Identity Platform Admin companion contract:

```text
/internal/v1/platform-admin/applications*
```

This control plane supports:

- list/create/read/update applications;
- create/list/revoke `lsa_*` credentials;
- register/list/revoke Cloudflare Access audiences;
- cross-application Service Principal/Service API Token management;
- read-only global user/Access-principal inspection;
- platform-admin audit reads.

Credential plaintext remains one-time-only and is never returned by metadata/list APIs.

The global bootstrap secret must never be copied into Console Worker/BFF runtime configuration.

## Service principals are separate

`lsp_pat_*` and OAuth service credentials authenticate service principals. They are not interchangeable with `lsa_*`.

A Console executor may be allowed to manage service principals across applications through `services:manage`, but the resulting service credentials remain bound to the target application/service-principal scope ceilings and normal Core Data Grant/model authorization.

See `docs/service-authentication.md`.

## Web/BFF requirements

- Browser JavaScript never receives raw Access assertions, LifeSpace user bearers, platform-admin actor proofs, `lsa_*`, `lsp_pat_*`, bootstrap secrets or equivalent executor credentials.
- Short link `scanToken` plaintext is application-backend material. When an adapter can render the provider-specific code server-side, the browser should receive only the rendered artifact plus non-secret challenge metadata rather than the raw scan token.
- Each Web app uses a same-origin BFF and host-only application/session cookies where cookies are needed.
- Do not use a parent-domain `Domain=aisr.online` session cookie for SSO/authority sharing.
- Cloudflare Access provides Web SSO; Identity exchange resolves LifeSpace identity/authority.
- The browser must not choose decoded Access `sub`, email, audience or target `usr_*`.
- Purpose-specific BFF endpoints must validate identifiers/query bounds and never accept a client-controlled upstream URL/path/Authorization header.
- CSRF-sensitive cookie-backed writes must validate exact Origin and use the application BFF boundary.

## Contract ownership

Normal application authentication/user/service syntax is owned by:

```text
apps/identity/openapi.yaml
Identity contract 0.6.0
```

Privileged LifeSpace Console syntax is separately owned by:

```text
apps/identity/platform-admin.openapi.yaml
Platform Admin contract 0.1.0
```

Adding privileged Console surfaces must not silently broaden the business application contract consumed by HomeMew/ALOHA.

## Rotation and recovery

Application credential rotation remains:

```text
create replacement lsa_*
-> store it in the backend secret store
-> deploy/restart and verify
-> revoke old credential
-> verify old credential fails
```

Lost plaintext is never recoverable; create a replacement instead.

Platform-administrator assignment/revocation remains a provisioning/recovery action under the bootstrap boundary. Revoking an assignment prevents new actor proofs and causes Identity-owned privileged calls to fail current assignment re-checks. Existing actor proofs are short-lived (maximum five minutes), bounding Core-side revocation latency without duplicating Identity administrator state.

## Non-goals

- LifeSpace-managed Google/Microsoft/email provider accounts for Web SSO in this phase.
- Treating the P1 Mini Program scan-link transport as LifeSpace becoming a WeChat IdP or as the later Cloudflare Access OIDC scan-login feature.
- Email-based automatic account merging.
- Implicit principal transfer between two different `usr_*` users; this requires an explicit future merge/recovery capability.
- A generic external-provider identity table containing application-owned subjects.
- Shared parent-domain authentication cookies.
- Bootstrap secret as a normal Console runtime credential.
- Ordinary `platform:admin` user tokens usable as long-lived administrator sessions.
- Browser exposure of Access/LifeSpace/actor/application/service executor bearer material.
