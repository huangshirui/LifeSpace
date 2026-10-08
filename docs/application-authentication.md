# Trusted Application and Access Authentication

## Status

- Cloudflare Access is the long-term Web/PWA authentication and SSO layer.
- Identity Application Contract is `0.11.0`.
- Identity Platform Admin companion contract is `0.5.0`; it includes the platform-administrator/purpose-bound actor foundation plus Application-scoped Agent identity governance for Console.
- `Application` is the registered application access subject. It is deliberately independent of Web/Mini Program/PWA/BFF/Worker/deployment topology.
- Access principal verification, audience registration, explicit registration/linking and trusted application credential lifecycle are implemented.
- `apps/console` has the permanent React/Vite same-origin BFF shell and uses the platform-admin control-plane boundary described here. Environment rollout/acceptance status belongs in current deployment/status documents rather than this authentication contract.

## Purpose

LifeSpace deliberately separates three authentication boundaries:

1. **application-owned provider identity** — the application resolves its own provider identifier to a LifeSpace `usr_*`, then a trusted backend for that Application authenticates to Identity with `lsa_*`;
2. **Cloudflare Access platform identity** — Identity independently verifies the raw Access assertion and owns `(iss, sub) -> usr_*` mapping for Access-protected Web/PWA entry points;
3. **platform administration** — a verified LifeSpace human actor and a separate controlled backend executor are both required for privileged Console operations.

These boundaries must not be collapsed into one generic external-identity or administrator-token model.

## Application boundary

A LifeSpace Application is a registered, trusted and governed **application access subject**. It is not a classification of the owning product's frontend, provider, BFF, Worker or deployment topology.

Normative rules:

- LifeSpace does not model `web`, `mini_program`, `service`, `device`, PWA, BFF or Worker as Application types.
- One product application may expose several client entry points and several backend deployment units while remaining one LifeSpace Application when they share one product-level LifeSpace authority boundary.
- One Application may hold several active `lsa_*` credentials for independent backend deployments, zero-downtime rotation and independent revocation. Multiple credentials do not create multiple Applications.
- A Cloudflare Access audience represents one protected Access entry point bound to an Application; it does not classify the Application as Web.
- Service Principals, Agents and their credentials are first-class identities/actors scoped under an Application; they are not substitute Applications merely because they execute independently.
- If two products intentionally require independent LifeSpace scope ceilings, credential ownership, operator lifecycle or application identity (`azp`), they should be separate Applications. Runtime packaging alone is not sufficient reason.

## Trusted application credential: `lsa_*`

A trusted backend/BFF acting for a LifeSpace Application authenticates to Identity with a revocable server-only credential:

```text
lsa_<random-secret>
```

`lsa_*` represents a registered **Application trusted backend credential**. It is not:

- a user credential;
- a service principal credential for Core;
- a browser/session token;
- a client/deployment identity;
- a platform bootstrap secret.

Plaintext is returned exactly once when a credential is created. Identity stores only its cryptographic hash and non-secret suffix/metadata. Multiple active credentials may overlap during zero-downtime rotation or independent backend deployment; revocation takes effect immediately on subsequent Identity authentication.

`lsa_*` must never appear in Mini Program code, browser JavaScript, mobile/downloadable clients, repository source, logs or documentation examples containing a real secret.

## Application-owned external identity

Application-specific provider identifiers remain in the owning application boundary.

Example: a Mini Program entry point owned by an Application.

```text
WeChat server-side authentication
  -> Application backend resolves provider subject
  -> Application mapping resolves provider subject -> usr_123
  -> Application backend authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived app-scoped LifeSpace user token
```

Identity never receives or persists the WeChat `openid`. The same ownership rule applies to WeCom IDs, school-system IDs and other application-specific subjects.

The Application may assert an already-resolved LifeSpace user only after authenticating with an active trusted application credential. Identity derives `azp`, allowed scope ceiling and token TTL from current registered Application state; the caller cannot choose another Application or exceed that ceiling.

A Web/PWA entry point and a provider-specific entry point may belong to the same Application. Their provider/authentication mechanisms remain different even though issued LifeSpace tokens share the same Application `azp`.

## Cloudflare Access platform identity

Cloudflare Access is intentionally different because it is the shared owner-controlled authentication/SSO layer for Web/PWA entry points.

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
- binding a verified Access audience to the registered LifeSpace Application context;
- explicit account registration/linking;
- issuing app-scoped LifeSpace credentials.

Identity is not a parallel Google/Microsoft/email IdP and does not persist their provider refresh tokens or provider subject IDs.

## Access identity and application keys

User identity, Access entry point and Application identity are separate:

```text
(iss, sub) -> LifeSpace usr_*
(iss, aud) -> registered LifeSpace Application / azp
```

Normative rules:

- `sub` is never reused as `usr_*`;
- `aud` identifies a protected Cloudflare Access entry point, not the human and not an Application client type;
- one `(issuer, audience)` registration can belong actively to only one LifeSpace Application;
- one Application may own more than one Access audience;
- multiple audiences may still resolve the same `(iss, sub)` to the same `usr_*`;
- the calling `lsa_*` Application and matched Access audience must agree;
- email is non-authoritative metadata and never auto-merges accounts;
- one `usr_*` may intentionally own multiple Access principals.

Identity persistence for Access platform identity is implemented using dedicated `access_audiences`, `access_principals` and one-time `access_link_challenges` state. Application-owned provider IDs do not belong in those tables.

## Normal Web token exchange

A same-origin Web BFF keeps one trusted backend `lsa_*` for its owning Application server-side, obtains the original Access assertion from the Cloudflare-protected request and calls:

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
validate lsa_* and calling Application
validate Access signature / configured iss / lifetime / sub
match one aud to an active registration for the same Application
resolve (iss, sub) -> usr_*
check user/principal/Application state
intersect requested scopes with Application ceiling
issue short-lived app-scoped LifeSpace user token
```

The BFF may perform its own perimeter/session validation, but BFF-supplied `sub`, email or `userId` is never accepted as Identity authority.

## First-use Access resolution

A valid but unknown Access principal does not silently create or merge a LifeSpace user.

There are only two supported paths:

1. explicitly create a new `usr_*` and bind the verified principal;
2. prove control of an existing LifeSpace account and link the principal to that user.

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

An already authenticated LifeSpace user confirms it with their current LifeSpace user token:

```text
POST /api/v1/me/access-link-challenges/{challengeId}/confirm
Authorization: Bearer <LifeSpace user JWT>
```

The target `usr_*` is derived only from the verified LifeSpace bearer token. The challenge is high-entropy, Application/audience/principal-bound, expires after ten minutes and is single-use. Consumption and principal-link insertion are atomic.

This allows an existing application user to link Web Access identity without exposing the Application's provider-specific subject to Identity.

## Multiple Access principals

LifeSpace explicitly supports:

```text
Access principal A ----+
                       +--> usr_123
Access principal B ----+
```

Cloudflare may normalize some upstream identities itself, but LifeSpace does not depend on that behavior. A distinct verified Access `sub` remains unlinked until explicit proof succeeds.

Automatic merge by email, display name or other mutable claim is forbidden.

## Platform-admin human proof

Cloudflare Access entry to `lifespace.aisr.online` is necessary but insufficient for LifeSpace platform administration.

Identity owns explicit `platform_administrators` assignments. Initial assignment/recovery is bootstrap-only.

A user must first have an ordinary short-lived LifeSpace user token for the Console Application. A currently assigned administrator may then request:

```text
POST /api/v1/me/platform-admin-actor-token
Authorization: Bearer <ordinary Console LifeSpace user JWT>
```

Identity verifies:

- the user is active;
- a current `platform_administrators` assignment is active;
- the calling LifeSpace Application is active;
- that Application is allowed `platform:admin`.

It returns a dedicated proof with:

```text
principal_type = user
scope          = platform:admin
purpose        = platform_admin_actor
azp            = Console Application
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

Actor `azp` and executor Application ID must match.

For Core-owned administration the same human proof is paired with a Core service executor, described in `docs/permissions.md` and `docs/service-authentication.md`.

## Platform-admin application management

Bootstrap Application administration remains available for provisioning/break-glass, but normal Console runtime uses the Identity Platform Admin companion contract:

```text
/internal/v1/platform-admin/applications*
```

This control plane supports:

- list/create/read/update Applications;
- create/list/revoke `lsa_*` credentials;
- register/list/revoke Cloudflare Access audiences;
- list/create/update stable Agent identities bound to target trusted Applications;
- cross-Application Service Principal/Service API Token management;
- read-only global user/Access-principal inspection;
- platform-admin audit reads.

Agent identity governance reuses `applications:manage`. Console uses its own executor and must never borrow the target Application's `lsa_*`. Creating an `agt_*` grants no Space/Data/Model authority, creates no Delegation and mints no Agent execution token. Agent `status` is global across all Application bindings, so operator tooling must present disable/reactivate as a global identity action rather than a local binding toggle.

Credential plaintext remains one-time-only and is never returned by metadata/list APIs.

The global bootstrap secret must never be copied into Console Worker/BFF runtime configuration.

## Service principals are separate

`lsp_svc_*` and OAuth service credentials authenticate Service Principals; legacy `lsp_pat_*` remains accepted only as migration input. They are not interchangeable with `lsa_*`.

A Console executor may be allowed to manage Service Principals across Applications through `services:manage`, but the resulting service credentials remain bound to the target Application/Service Principal scope ceilings and normal Core Data Grant/model authorization.

See `docs/service-authentication.md`.

## Web/BFF requirements

- Browser JavaScript never receives raw Access assertions, LifeSpace user bearers, platform-admin actor proofs, `lsa_*`, `lsp_pat_*`, bootstrap secrets or equivalent executor credentials.
- Each Web/PWA entry point uses a same-origin BFF and host-only application/session cookies where cookies are needed.
- Separate BFF/deployment units of one Application may use separate active `lsa_*` credentials while retaining the same Application `azp` and scope ceiling.
- Do not use a parent-domain `Domain=aisr.online` session cookie for SSO/authority sharing.
- Cloudflare Access provides Web SSO; Identity exchange resolves LifeSpace identity/authority.
- The browser must not choose decoded Access `sub`, email, audience or target `usr_*`.
- Purpose-specific BFF endpoints must validate identifiers/query bounds and never accept a client-controlled upstream URL/path/Authorization header.
- CSRF-sensitive cookie-backed writes must validate exact Origin and use the application BFF boundary.

## Contract ownership

Normal application authentication/user/service syntax is owned by:

```text
apps/identity/openapi.yaml
Identity Application Contract 0.11.0
```

Privileged LifeSpace Console syntax is separately owned by:

```text
apps/identity/platform-admin.openapi.yaml
Identity Platform Admin Contract 0.5.0
```

Adding privileged Console surfaces must not silently broaden the business Application contract consumed by downstream applications.

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

Creating an additional credential for an independently deployed backend of the same Application uses the same lifecycle but does not imply that the prior credential must be revoked. Credential metadata and deployment ownership are operational concerns; Application identity remains stable.

Platform-administrator assignment/revocation remains a provisioning/recovery action under the bootstrap boundary. Revoking an assignment prevents new actor proofs and causes Identity-owned privileged calls to fail current assignment re-checks. Existing actor proofs are short-lived (maximum five minutes), bounding Core-side revocation latency without duplicating Identity administrator state.

## Non-goals

- LifeSpace-managed Google/Microsoft OAuth provider accounts for Web SSO.
- Email-based automatic account merging.
- A generic external-provider identity table containing application-owned subjects.
- A LifeSpace client/deployment taxonomy for Web, Mini Program, PWA, BFF, Worker, device or service packaging.
- Shared parent-domain authentication cookies.
- Bootstrap secret as a normal Console runtime credential.
- Ordinary `platform:admin` user tokens usable as long-lived administrator sessions.
- Browser exposure of Access/LifeSpace/actor/application/service executor bearer material.
