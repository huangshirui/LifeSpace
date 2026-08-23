# LifeSpace Architecture

## Purpose

LifeSpace is the shared platform for ALOHA, HomeMew and future vertical applications. It is the source of truth for global Identity, Space/Data Grant authorization, metadata-driven domain models, migrations, contracts and Cloudflare deployment configuration.

Applications are product experiences over the platform. They do not own parallel copies of LifeSpace users, Spaces, Grants or ordinary domain data.

Ordinary business models are declarative Model Definitions interpreted by a fixed Generic Runtime. New Core source code should normally represent a reusable Runtime/Engine/Capability/physical-schema concern or an explicit Kernel/control-plane concern, not one more handwritten CRUD implementation.

Historical extraction and phase evidence lives in the phase/status and migration documents. This document describes the current target architecture and normative boundaries.

## Repository and service boundaries

The platform remains a modular monolith split into two authoritative deployed services:

- `apps/identity`: global LifeSpace users, Cloudflare Access principals, registered applications and `lsa_*` application credentials, service principals and service credentials, signing/issuance, platform-administrator assignments, Identity-owned platform-admin audit.
- `apps/core`: Spaces, memberships, Space People, Data Grants, Model Registry, Application × Model Access, Generic Runtime, typed model storage, reusable Capabilities, model administration, Core-owned platform-admin audit.

`apps/console` is the LifeSpace platform operations/governance client and same-origin BFF. Its permanent frontend is React + TypeScript + Vite on a Cloudflare Worker/Static Assets deployment. It consumes Identity/Core control-plane contracts and must never become a third source of truth for Identity or Core state.

## Normal runtime flows

```text
Owner-controlled Web/PWA browser
  -> Cloudflare Access authentication + SSO
  -> same-origin application BFF
  -> LifeSpace Identity independently verifies Access assertion
  -> Access (iss, sub) -> global usr_*
  -> registered Access aud -> LifeSpace application / azp
  -> short-lived app-scoped LifeSpace user credential
  -> LifeSpace Core

Mini Program / untrusted client
  -> application-owned provider authentication
  -> application-owned external-id -> usr_* mapping
  -> trusted backend authenticates to Identity with server-only lsa_*
  -> short-lived app-scoped LifeSpace user token
  -> LifeSpace Core

Owner-controlled n8n / script / MCP / backend
  -> opaque lsp_pat_* Service API Token
  -> LifeSpace Core

Third-party or policy-controlled service
  -> OAuth client_credentials
  -> short-lived service JWT
  -> LifeSpace Core
```

Cloudflare Service Bindings may be used for same-account transport, but transport topology is never authorization. Explicit principal, application, scope and current-state authorization remain mandatory.

## Core request architecture

```text
Request
  -> authentication
  -> Kernel/control-plane route OR model route resolution
  -> current credential/application authority
  -> current Space membership / Data Grant authority
  -> model access capability + policy
  -> schema/relation validation
  -> Generic Runtime / Capability hooks
  -> typed model / relation / capability storage
  -> audit / response
```

Stable model metadata may be compiled/cached in a Worker isolate. Mutable authority such as memberships, Grants, Application × Model Access and credential state must retain current-state revocation semantics.

## Kernel

Kernel concepts remain explicit platform concepts and cannot be created as ordinary user-defined models:

- Identity/Application/Principal and credential state;
- Space, Membership and Space Person;
- Data Grant and authorization state;
- Model Registry administration and publication state;
- Application × Model Access;
- Registry-driven Creation Draft orchestration;
- platform administration and audit;
- security/signing/deployment state.

The business-facing Core Kernel contract remains deliberately stable and separate from the privileged Console control plane; see **Contract layers** below.

## Model Registry and Generic Runtime

Published Model Definitions are the logical source of truth for ordinary business-model schema. They are validated, immutable by version, schema-hashed and compatibility classified.

A Worker isolate loads the published model set and compiles Runtime Model Descriptors indexed by model key and route. Those descriptors precompute stable field/query/relation/access metadata. Normal hot-path model requests do not need a Registry D1 read for every request.

Each successful model publish/retire activates an immutable content-addressed Model Contract Revision:

```text
mct_<sha256(canonical(manifest + openapi + jsonSchema))>
```

AI Model Designer or another Agent may propose a Model Definition, but it has no implicit publication authority and no arbitrary DDL/code execution path. Publication always goes through the same validator, compatibility gate and Model Admin boundary.

## Physical persistence

Logical metadata-driven modeling is independent from physical persistence. The converged runtime uses deterministic typed storage rather than a universal schemaless business-data JSON table.

Conceptual shape:

```text
resource_records
  record identity
  source space_id
  model key/version
  optimistic version
  actor/timestamp/soft-delete audit envelope

mdl_<model_key>
  typed scalar business columns
  duplicated space_id for query locality only
  generated query indexes

resource_relations
  person/record/list relation values

Capability projections
  temporal/calendar/future capability-specific persistence
```

The Physical Schema Compiler is fixed platform code. It derives bounded DDL only from validated Model Definitions. Arbitrary SQL, JavaScript, shell fragments or model-supplied executable code are forbidden.

## Effective authorization

For an ordinary model operation, effective permission is the intersection of:

```text
verified principal
∩ stable credential scope
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ published model access capability
∩ model policy / Capability restrictions
```

A hostname, Access session, application name, service credential or model publication grants nothing by itself.

Every ordinary business record belongs to exactly one source Space. Sharing uses Data Grants or approved derived views and does not copy or move the authoritative record.

Normative authorization details are in `docs/permissions.md`.

## Identity boundary

LifeSpace Identity is authoritative for the global `usr_*`. One natural person may reach the same user through multiple approved authentication paths.

Application-specific provider identifiers remain application-owned. Examples include WeChat `openid`, WeCom IDs or a school-system subject. Those mappings remain in the owning application and are not generalized into Identity.

Cloudflare Access is the deliberate platform exception because it is the shared long-term Web/PWA authentication and SSO layer. Identity owns:

```text
(Access iss, Access sub) -> LifeSpace usr_*
(Access iss, Access aud) -> registered LifeSpace application context
```

The identity key is `(iss, sub)`. `aud` identifies application context, not the user. Email is non-authoritative metadata and must never auto-merge accounts.

Unknown Access principals require an explicit choice: link to an existing LifeSpace account after proof of control, or explicitly create a new LifeSpace user and bind the current principal. Multiple Access principals may intentionally link to one `usr_*`.

Identity is not a general-purpose Google/Microsoft/email IdP. Those upstream login methods remain configured in Cloudflare Access.

## Web/BFF and cookie boundary

Each Web application owns its own same-origin BFF boundary. Browser JavaScript must not receive `lsa_*`, `lsp_pat_*`, bootstrap secrets or equivalent backend credentials.

Identity/session cookies are host-only; LifeSpace does not use a parent-domain `Domain=aisr.online` cookie to share authority between applications. SSO is established by Cloudflare Access and explicit Identity exchange rather than by a shared parent cookie.

Core remains a bearer/service-authenticated API and must not infer application identity from Host.

## Service and automation authentication

LifeSpace supports two service modes:

- opaque, revocable `lsp_pat_*` Service API Tokens for owner-controlled trusted workloads;
- OAuth `client_credentials` for short-lived service JWTs when required by third-party or policy constraints.

Both authenticate a `service` principal and are bounded by application/service scope ceilings, Application × Model Access, current Data Grants and model policy.

`lsa_*` is a different credential: it authenticates a trusted application backend to Identity and does not itself represent a service principal to Core.

Normative details are in `docs/service-authentication.md`.

## LifeSpace platform administration

LifeSpace Console is the platform operations/governance client for `lifespace.aisr.online`. It is not a HomeMew administrator, ALOHA administrator or generic business-data editor.

Cloudflare Access controls entry to the Console but does not itself grant LifeSpace platform-admin authority.

### Human actor authority

Identity owns explicit `platform_administrators` assignments. An ordinary LifeSpace user JWT is not accepted as privileged operator proof.

A currently assigned administrator, using a LifeSpace application whose scope ceiling contains `platform:admin`, may obtain:

```text
POST /api/v1/me/platform-admin-actor-token
```

The result is a dedicated RS256 user proof with:

```text
purpose = platform_admin_actor
scope   = platform:admin
azp     = Console LifeSpace application
TTL     <= 5 minutes
```

This purpose-bound proof is sent as `X-LifeSpace-Actor-Token` on privileged Console calls. Raw `userId`, email, Access `sub`, decoded claims or unsigned headers are never accepted as human-actor authority.

### Controlled executor authority

The same-origin Console BFF separately holds controlled server credentials:

```text
Identity control plane:
  lsa_* trusted application credential

Core control plane:
  service principal credential / lsp_pat_* or equivalent service JWT
```

Executor capabilities are operation-specific, for example:

```text
applications:manage
services:manage
models:manage
spaces:inspect
identities:read
audit:read
```

Actor and executor must resolve to the same LifeSpace application context. The Console cannot pair a human proof issued to one application with an executor belonging to another.

Identity re-checks the current platform-administrator assignment on Identity-owned privileged calls. Core independently verifies the signed, short-lived actor proof and does not duplicate the Identity administrator-assignment table.

### Console BFF boundary

The Console browser talks only to bounded same-origin `/api/*` operations. The Worker owns the complete privileged chain:

```text
raw Access assertion
-> Identity exchange
-> app-scoped LifeSpace user bearer
-> <=5-minute actor proof
-> fixed Identity/Core admin request
```

Raw Access JWTs, LifeSpace user bearers, actor proofs and executor credentials remain server-only. The BFF does not accept a browser-controlled upstream URL/path/Authorization header. Identifier formats, query names, duplicate query parameters and result limits are validated before an upstream request is constructed.

The current React/Vite Console slice exposes only read-only governance/diagnostic operations plus one staging-only first-use registration for the current verified Access principal. Write-capable platform administration is a separate slice and must preserve the same actor/executor and audit boundary.

### Audit

Privileged mutations record both identities:

- human `usr_*` actor;
- backend/service executor;
- operation and target;
- bounded secret-free before/after or summary data;
- request ID;
- timestamp and result.

Credential plaintext and hashes are never audit fields.

For Console-triggered Model publish/retire, Core writes an initial pending audit record before Registry mutation begins, then marks the result success/failure. If the initial audit record cannot be persisted, the mutation does not start. Existing non-Console service automation using `models:manage` remains supported.

### Bootstrap authority

The global bootstrap secret remains provisioning and break-glass authority. It is used for initial/recovery operations such as platform-administrator assignment and must not be stored in Console runtime configuration or exposed to browser code.

## Contract layers

LifeSpace has separate contracts for product runtime and privileged control-plane consumers.

### Identity

```text
Application / user / service contract
  apps/identity/openapi.yaml
  current business-facing contract: 0.5.0

Platform Admin Control-Plane Contract
  apps/identity/platform-admin.openapi.yaml
  independent companion contract: 0.1.0
```

### Core

```text
Kernel Contract
  apps/core/openapi.yaml
  explicit product-facing Space / Grant / Creation Draft / Model Admin primitives
  current Kernel contract: 0.12.0

Platform Admin Control-Plane Contract
  apps/core/platform-admin.openapi.yaml
  independent companion contract: 0.1.0

Model Contract Revision
  mct_<sha256>
  concrete published ordinary-model CRUD/query/action/Capability contract
```

The separate Platform Admin contract prevents adding Console-only privileged APIs from forcing unrelated HomeMew/ALOHA business-contract pin changes. HomeMew handoff artifacts therefore continue to pin Identity/Core Kernel/Model Contract and do not automatically include the Platform Admin contract.

Contract publication/versioning rules are normative in `docs/contracts.md`.

## Console topology

Production topology:

```text
lifespace.aisr.online
  -> Cloudflare Access
  -> LifeSpace Console Worker/BFF + React/Vite static assets
       -> Identity control plane
       -> Core control plane
```

Staging hostname:

```text
lifespace-staging.aisr.online
```

Production and staging use separate Access Applications/audiences, Console Workers, environment-specific credentials and corresponding Identity/Core runtime/data stores.

The Console lives in this monorepo as `apps/console`. The Cloudflare Vite plugin owns the built client output and generated Worker deployment configuration. The target Cloudflare environment is selected at Vite build time (`CLOUDFLARE_ENV=staging|production`); the old dependency-light `public/` proving assets are no longer the permanent presentation path.

## Deployment topology

Primary platform domains:

- `auth.aisr.online` -> Identity Worker;
- `core.aisr.online` -> Core Worker;
- `lifespace.aisr.online` -> Console Worker/BFF behind Cloudflare Access;
- application domains -> their own Worker/Pages/BFF deployments.

Staging uses the corresponding isolated staging services and data stores. A staging Console proof must never modify production LifeSpace or HomeMew traffic/data.

Publishing a compatible ordinary Model Definition does not itself require a Worker deployment after typed-storage convergence. Kernel/Capability/control-plane runtime code and repository-owned schema migrations still use the normal deployment process.

## Non-negotiable invariants

- One global `usr_*` per LifeSpace person; application-specific external IDs remain app-owned except Cloudflare Access platform principals.
- Every ordinary record has exactly one source Space.
- Grants share authority without changing ownership.
- No shared parent-domain authentication cookie.
- No application authority inferred from hostname.
- No arbitrary executable code/SQL in Model metadata.
- No service credential or platform-admin executor becomes a hidden Space member.
- No browser receives Access/LifeSpace/actor/executor/backend/bootstrap bearer material.
- No Cloudflare Access session alone equals LifeSpace platform-admin authority.
- No privileged Console mutation may replace the signed human actor proof with an unsigned identity field.
