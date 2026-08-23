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

Core has two explicit authentication adapters that produce the same normalized principal context:

```text
RS256 user/service JWT
  -> local signature/claim verification

opaque lsp_pat_*
  -> Identity introspection through internal Service Binding
  -> current token + principal state
```

Positive opaque-token caching is not part of the correctness boundary unless future measured performance work introduces a revocation-safe design.

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

## Model Admin automation compatibility

Existing service automation with `models:manage` remains valid for non-interactive platform workflows.

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

OAuth service JWT lifetime defines the bounded delay for credential-state changes that are encoded into an already-issued short-lived JWT. Opaque tokens use current introspection state on the next request.

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

Core migration `0026_platform_admin_audit.sql` adds Core-side platform-admin audit storage. Core continues to reference stable service principal IDs in Data Grants rather than individual token IDs.

## Contract ownership

Normal service/application syntax:

```text
apps/identity/openapi.yaml
Identity contract 0.5.0
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

Product applications such as HomeMew do not need to repin their business contract merely because the platform Console gains a new privileged administration endpoint.

## Non-goals

- Permanent personal-user API tokens.
- Service/application credentials in browsers, Mini Programs or downloadable clients.
- Long-lived JWTs pretending to be revocable opaque tokens.
- Hidden Space membership for services or platform executors.
- Bootstrap secret as normal Console/service runtime authority.
- One universal service token reused across environments/workloads.
- OAuth as a mandatory indirection for every owner-controlled trusted service.
