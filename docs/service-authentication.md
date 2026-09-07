# Service and Automation Authentication

## Status

LifeSpace supports both opaque Service API Tokens and OAuth `client_credentials`. OAuth is not mandatory for owner-controlled trusted workloads.

Normal service syntax is part of the Identity application/user/service contract. Platform-wide cross-application service administration for LifeSpace Console is a separate Platform Admin control-plane surface.

## Credential modes

### Opaque Service API Token

Recommended for owner-controlled n8n, scripts, cron jobs, MCP servers and trusted backend automation:

```text
lsp_pat_<cryptographically-random-secret>
```

The caller sends it directly to Core:

```http
Authorization: Bearer lsp_pat_...
```

From the caller's point of view this remains one business HTTP request. Core recognizes the opaque token and asks Identity for current introspection through the internal service boundary.

### OAuth `client_credentials`

Recommended when a third party, enterprise policy or automatic short-lived credential rotation requires OAuth.

The service exchanges its OAuth client credential at Identity for a short-lived service JWT, then calls Core with that JWT.

Both modes normalize to the same `service` principal and the same Core authorization model.

## Effective service authority

A valid service credential does not grant arbitrary Space/model access.

Effective authority remains:

```text
verified service principal
∩ current credential scopes
∩ registered application scope ceiling
∩ service-principal maxScopes
∩ Application × Model Access
∩ current Data Grants
∩ model capability/policy
```

A service principal is never made a hidden Space member or administrator merely so it can call an API.

## Identity/Core ownership

Identity owns:

- service principals;
- opaque Service API Token hashes/metadata;
- OAuth client credentials;
- service JWT issuance;
- application scope ceilings;
- current credential/principal status.

Core owns:

- Data Grants;
- Application × Model Access;
- Space/model authorization;
- business execution.

Core must not duplicate Identity credential hashes or directly read Identity D1.

## Opaque token storage and lifecycle

Service API Token requirements:

- generate at least 256 bits of cryptographically secure random secret material;
- store only the token hash plus non-secret lookup/display metadata;
- return plaintext exactly once at creation;
- never return plaintext or hashes from list/get APIs;
- allow explicit label and scope metadata;
- allow `expiresAt = null` for owner-controlled trusted workloads;
- support immediate revocation;
- support service-principal disablement;
- support rotation by creating a replacement then revoking the old token;
- support per-token scope reduction;
- never allow an existing token to gain new authority merely because a service principal/application ceiling was later expanded;
- use separate credentials for staging and production.

A long-lived token is opaque rather than a long-lived JWT so revocation and scope reduction remain current-state decisions.

## Core verification paths

Core has explicit authentication adapters that produce the same normalized principal context:

```text
RS256 user JWT
  -> local signature/claim/lifetime verification

RS256 service JWT
  -> local signature/claim/lifetime verification
  -> current Service Principal + owning Application eligibility through the internal Service Binding

opaque lsp_pat_*
  -> Identity introspection through internal Service Binding
  -> current token + principal state
```

For an already-issued service JWT, the locally verified token remains the signed source of its token-bounded claims, but it is not an authority lease for Service Principal or owning Application active state. Core must confirm those two current states with Identity before accepting the normalized service principal. Missing/inactive status denies the request; inability to establish required current status fails closed rather than falling back to the locally valid JWT.

Positive opaque-token or service-principal-eligibility caching is not part of the correctness boundary unless future measured performance work introduces a revocation-safe design.

### Passive Eventing subscriber eligibility

Normal Eventing Webhook delivery is different from an inbound Core API request: the subscriber does not present its `lsp_pat_*` or service JWT to LifeSpace for every outgoing notification. A stale Data Grant or subscription must therefore never become a substitute for current service identity state.

Core keeps only the stable subscriber `svc_*` reference. After current Core-owned Endpoint/Subscription, Application × Model Access and Data Grant checks pass, the Queue consumer performs a final current-state eligibility read against Identity through the existing authenticated Core -> Identity Service Binding immediately before any outbound Webhook attempt. The internal implementation route is:

```text
GET /introspection/v1/service-principals/{principalId}
X-LifeSpace-Internal-Secret: <Core/Identity internal secret>
```

Identity returns only whether the stable Service Principal is currently eligible. Eligibility requires both the Service Principal and its owning registered application to be active. Missing/malformed principals are ineligible.

This endpoint is a private Core↔Identity runtime boundary, not ordinary application/service client syntax. It is not exposed as a new HomeMew/ALOHA-consumable API and does not by itself change the pinned Identity Application Contract. The externally observable authority result was already part of the service-disable semantics: a disabled Service Principal must not continue receiving platform-authorized work merely because another service retains stale cleanup state.

Failure semantics are deliberately asymmetric:

- explicit inactive/missing -> Core cancels and acknowledges that Eventing delivery without sending the Webhook;
- Identity unavailable/non-success/invalid response -> Core sends nothing, records a failed delivery attempt state without crossing the outbound boundary, and asks Cloudflare Queue to retry;
- no positive subscriber-eligibility cache or replicated Identity status is part of the correctness boundary.

The extra Service Binding + Identity current-state read applies only to deliveries that survive Core's own current authority checks. This preserves Identity as the status source of truth while avoiding a second service-principal-state store in Core.

## Delegated Agent execution is not service automation

An Agent acting under a user's authority uses a distinct execution context from a `service` principal. Identity registers a stable Agent identity (`agt_*`) inside an application context and may issue a short-lived Core-only JWT carrying `principal_type=user`, `actor_type=agent`, `actor_id=agt_*` and `purpose=delegated_agent`. Core then intersects that credential with the user's current Space/model authority and an explicit current User -> Agent Delegation.

The Agent token does not grant authority by itself, cannot be reused against Identity user-profile APIs, and does not turn the Agent into a Space member. Revoking the Core Delegation blocks later requests immediately even if the short-lived token remains cryptographically valid.

## `lsa_*` is not a service token

A trusted application credential:

```text
lsa_<random-secret>
```

authenticates a registered **application backend to Identity**. It does not represent a service principal directly to Core.

Typical application-owned identity flow:

```text
application backend resolves external provider identity -> usr_*
-> authenticates to Identity with lsa_*
-> receives short-lived app-scoped LifeSpace user JWT
-> user JWT calls Identity/Core
```

`lsa_*`, `lsp_pat_*` and OAuth client credentials must never be exposed to browser/Mini Program/mobile client code.

See `docs/application-authentication.md` for the application and Cloudflare Access boundary.

## Self-service service-principal management

A trusted application backend may manage service principals inside its own application context through the normal Identity API:

```text
GET    /api/v1/service-principals
POST   /api/v1/service-principals
PATCH  /api/v1/service-principals/{principalId}

GET    /api/v1/service-principals/{principalId}/tokens
POST   /api/v1/service-principals/{principalId}/tokens
PATCH  /api/v1/service-principals/{principalId}/tokens/{tokenId}
DELETE /api/v1/service-principals/{principalId}/tokens/{tokenId}

GET    /api/v1/service-principals/{principalId}/oauth-credentials
POST   /api/v1/service-principals/{principalId}/oauth-credentials
DELETE /api/v1/service-principals/{principalId}/oauth-credentials/{credentialId}
```

The application cannot escape its own registered application context or exceed its scope ceiling.

## LifeSpace Console cross-application service administration

LifeSpace Console needs platform governance across registered applications. It must not accomplish this by borrowing the target application's `lsa_*` credential or by using the bootstrap secret as a normal runtime credential.

Identity Platform Admin `0.1.0` therefore exposes a separate cross-application control plane under:

```text
/internal/v1/platform-admin/applications/{applicationId}/service-principals*
```

Every request requires two independent proofs:

```text
Authorization: Bearer <Console lsa_* executor>
X-LifeSpace-Actor-Token: <purpose=platform_admin_actor JWT>
```

The Console executor must have `services:manage`. The human actor must be a currently assigned LifeSpace platform administrator and the actor proof must belong to the same Console application context as the executor.

This surface supports:

- list/create service principals for a target application;
- update display metadata/maxScopes/status;
- list/create/reduce/update/revoke opaque Service API Tokens;
- one-time token plaintext return;
- secret-free platform-admin audit attribution.

The target application's current `allowedScopes` remains a hard ceiling. The Console does not manufacture authority outside registered application policy.

## Platform-admin executor service principal

Core-owned Console administration uses a dedicated service executor rather than an `lsa_*` application credential because Core authenticates service principals.

The Console Core executor should be dedicated to the Console application and granted only the capabilities needed by the deployed Console, for example:

```text
applications:manage
models:manage
spaces:inspect
audit:read
```

It is paired with the same five-minute human actor proof used by the Identity control plane. Actor and executor application context must match.

This executor is platform-control authority only. It must not receive broad Space Data Grants or become a hidden member of every Space.

## Model Control Plane automation compatibility

Existing service automation with `models:manage` remains valid for non-interactive platform workflows and pins the independently versioned Core Model Control Plane contract rather than the ordinary Kernel contract.

When LifeSpace Console triggers model publish/retire, the Console additionally supplies the purpose-bound human actor proof so Core can attribute the operation to both:

- the human `usr_*` actor;
- the service executor.

Console-triggered mutations write pending audit evidence before Registry mutation starts, then finalize success/failure. Failure to create the initial audit record prevents mutation from starting.

This preserves existing CI/automation behavior without weakening interactive Console auditability.

## n8n

For an owner-controlled n8n instance, use one Header Auth credential:

```text
Name: Authorization
Value: Bearer lsp_pat_xxxxx
```

Then call Core directly. No token-acquisition node is needed for opaque-token mode.

If OAuth `client_credentials` is deliberately chosen, configure n8n's OAuth2 credential normally and allow n8n to cache/refresh the short-lived access token rather than manually fetching a new token before every business request.

## curl and private scripts

Store the credential in an environment variable/secret manager:

```bash
curl "https://core.aisr.online/api/v1/spaces/spc_xxx/tasks" \
  -H "Authorization: Bearer ${LIFESPACE_TOKEN}"
```

Do not place a real token in shell history, repository files, workflow exports, Docker images or documentation.

## Device and delegated-user cases

A household display/device should use a dedicated narrowly scoped device credential policy. It must not reuse an administrator user token or general service token.

An Agent acting on behalf of a user should preserve delegated user authority. A permanent service administrator is not a substitute for user delegation.

## Revocation semantics

The following remove authority on subsequent requests:

- revoke an opaque token;
- disable its service principal;
- reduce token scopes;
- reduce application/service-principal ceilings;
- remove/reduce Application × Model Access;
- revoke/reduce a Data Grant;
- disable the registered application.

For OAuth service JWTs, **Service Principal and owning Application active status are current-state Authority**, not claims leased until JWT expiry. After either disablement commits, the next Core request authenticated by an already-issued service JWT must fail the Identity eligibility check even when the JWT remains cryptographically valid.

JWT lifetime may still bound changes to credential claims that are intentionally encoded into an already-issued short-lived JWT and are not separately classified as current-state Authority. This token-bounded behavior must never be interpreted to preserve a disabled Service Principal/application. Opaque tokens continue to use full current token/principal introspection on the next request.

For passive Eventing, Service Principal/application status is re-checked at the final queued delivery boundary rather than inferred from a previously created Data Grant or subscription. Principal disablement therefore stops subsequent normal Webhook delivery even if Grant cleanup partially fails. The revocation window is bounded by reaching that send-time gate; it is not extended by credential TTL or a positive Identity-status cache. If Identity cannot confirm current status, delivery fails closed and follows the Queue retry/DLQ policy instead of sending.

Re-enabling a Service Principal restores only Identity eligibility. It does not recreate a revoked token, Data Grant, Application × Model Access entry, Endpoint or Subscription; those independent authorities remain current-state requirements.

For the Console human actor, administrator assignment revocation prevents new actor proofs and Identity-owned admin calls re-check current assignment. Core does not duplicate that table; already-issued purpose-bound actor proofs expire within five minutes.

## Audit and secret handling

Platform/service audit may record:

- actor/executor identifiers;
- application/principal/token IDs;
- non-secret suffix/prefix/label metadata;
- operation, target, scope changes, result, timestamp and request ID.

It must never record:

- plaintext `lsa_*`;
- plaintext `lsp_pat_*`;
- OAuth client secrets;
- credential hashes;
- Authorization headers.

## Persistence

Identity migrations establish:

- application credentials;
- service principals;
- opaque Service API Tokens;
- OAuth service credentials;
- Cloudflare Access identity state;
- platform-admin audit;
- platform-administrator assignments.

Core migration `0026_platform_admin_audit.sql` adds Core-side platform-admin audit storage. Core continues to reference stable service principal IDs in Data Grants rather than individual token IDs. Eventing follows the same ownership rule: Core stores the subscriber `svc_*` reference but not a replicated Identity status column/table.

## Contract ownership

Normal service/application syntax:

```text
apps/identity/openapi.yaml
Identity contract 0.6.0
```

LifeSpace Console privileged service administration:

```text
apps/identity/platform-admin.openapi.yaml
Identity Platform Admin contract 0.1.0
```

Core Console administration:

```text
apps/core/platform-admin.openapi.yaml
Core Platform Admin contract 0.1.0
```

Product applications such as HomeMew do not need to repin their business contract merely because the platform Console gains a new privileged administration endpoint. The Core-only Service Principal eligibility read used to enforce already-declared Eventing revocation semantics is likewise not application-callable syntax and does not by itself require a business-application Identity repin.

## Non-goals

- Permanent personal-user API tokens.
- Service/application credentials in browsers, Mini Programs or downloadable clients.
- Long-lived JWTs pretending to be revocable opaque tokens.
- Hidden Space membership for services or platform executors.
- Bootstrap secret as normal Console/service runtime authority.
- One universal service token reused across environments/workloads.
- OAuth as a mandatory indirection for every owner-controlled trusted service.
