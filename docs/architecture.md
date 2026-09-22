# LifeSpace Architecture

## Purpose

LifeSpace is the shared platform for ALOHA, HomeMew and future vertical applications. It is the source of truth for global Identity, Space/Data Grant authorization, metadata-driven domain models, migrations, contracts and Cloudflare deployment configuration.

Applications are product experiences over the platform. They do not own parallel copies of LifeSpace users, Spaces, Grants or ordinary domain data.

Ordinary business models are declarative Model Definitions interpreted by a fixed Generic Runtime. New Core source code should normally represent a reusable Runtime/Engine/Capability/physical-schema concern or an explicit Kernel/control-plane concern, not one more handwritten CRUD implementation.

Historical extraction and phase evidence lives in the phase/status and migration documents. This document describes the current target architecture and normative boundaries. The long-term assumptions and axioms that justify these boundaries are defined in `docs/north-star.md`.

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

Cloudflare Service Bindings may be used for same-account transport, but transport topology is never authorization. Explicit authenticated identity/principal context, application, scope and current-state authorization remain mandatory.

## Core request architecture

```text
Request
  -> authentication
  -> Kernel/control-plane route OR canonical modelKey resolution
  -> current credential/application authority
  -> current Space membership / Data Grant authority
  -> model access capability + policy
  -> schema/relation validation
  -> Generic Runtime / Capability hooks
  -> typed model / relation / capability storage
  -> audit / response
```

Stable model metadata may be compiled/cached in a Worker isolate. Mutable authority such as memberships, Grants, Application × Model Access and credential state must retain current-state revocation semantics.

Passive delivery paths must preserve the same rule even when there is no inbound subscriber credential on the current invocation. In particular, Eventing stores only the stable subscriber `svc_*` reference in Core. The Queue consumer re-checks Core-owned authorization and then asks Identity, through the authenticated same-account Service Binding, whether the referenced Service Principal and its owning application are currently active immediately before any outbound Webhook request begins. Core does not replicate/cache that Identity status as durable authority. If Identity current state cannot be confirmed, delivery fails closed and retries rather than sending from stale positive state.

## Identity and operation-role terminology

The current deployed architecture and contracts use established authentication terms such as `principal`, `principal_type` and `service principal`. Those names remain valid implementation vocabulary and are not renamed by the North Star refinement.

For long-term conceptual design, keep two dimensions separate:

```text
Entity type
  User | Agent | Application | Service | future identifiable entity types

Operation roles/context
  principal          = whose authority is exercised
  actor              = who/what executes or initiates the operation
  applicationContext = through which application context it occurs
```

Therefore the platform must not treat `Principal -> User | Agent | Application | Service` as the durable ontology merely because a normalized authenticated identity is currently called a principal in code or contracts. A direct user operation may have the same user as Principal and Actor; a delegated Agent operation may use the user's authority while the Agent is the Actor. An Agent with explicitly granted independent authority may itself fill both roles.

This distinction is currently an architectural interpretation rule, not a declaration that a universal Agent/Actor persistence model or new public contract fields already exist.

## Kernel

Kernel concepts remain explicit platform concepts and cannot be created as ordinary user-defined models:

- Identity/Application/current authenticated principal and credential state;
- Space, Membership and Space Person;
- Data Grant and authorization state;
- Model Registry administration and publication state;
- Application × Model Access;
- Registry-driven Creation Draft orchestration;
- platform administration and audit;
- Eventing Webhook Endpoint/subscription/delivery state;
- security/signing/deployment state.

The business-facing Core Kernel contract remains deliberately stable and separate from the privileged Console control plane; see **Contract layers** below.

## Model Registry and Generic Runtime

Published Model Definitions are the logical source of truth for ordinary business-model schema. They are validated, immutable by version, schema-hashed and compatibility classified.

A Worker isolate loads the published model set and compiles Runtime Model Descriptors indexed only by stable `modelKey`. Canonical ordinary Runtime paths are `/api/v1/spaces/{spaceId}/models/{modelKey}/records/...`; a caller that knows `spaceId + modelKey` needs no Discovery. Descriptors precompute stable field/query/relation/access metadata, so normal hot-path model requests do not need a Registry D1 read for every request.

Ordinary read querying has one semantic composition model: `Search -> Filter(Boolean AST + typed predicates) -> Sort -> Cursor Pagination`. The structured Canonical Typed Query entry is `POST /api/v1/spaces/{spaceId}/models/{modelKey}/records/query`. Capability-specific planner/compiler code may contribute typed range or derived semantics, but Calendar/Temporal are not separate caller query languages. Existing GET Generic/Calendar/Temporal parameters remain compatibility transports during migration. Normative query semantics are in `docs/canonical-query.md`; platform time/location semantics are in `docs/time-space-semantics.md`.

The four pre-#200 ordinary Runtime aliases (`/tasks`, `/wishes`, `/events`, `/day-records`) were retired under #207 after consumer cutover and production verification. Current Runtime addressing is modelKey-only: callers use `/api/v1/spaces/{spaceId}/models/{modelKey}/records/...`. Historical migrations and release notes may still mention the former route segments as immutable deployment evidence; they are not current Runtime contracts or semantic identities.

Relation structure and relation instances deliberately live at different layers. Model Definition / generated JSON Schema owns stable relation target/cardinality semantics; Runtime Context Projection resolves current relation targets under live authority. Kernel `0.23.0` provides source-field-aware Person target lookup as minimal `{id,label}` references for generated clients without exposing Space membership-management data. This lookup is not a UI widget contract and is not mutation authority; adapters decide presentation, while create/update Policy and relation integrity are rechecked at execution. Kernel `0.29.0` adds model-owned canonical record `referenceLabel` semantics so `record` / `record_list` lookup and hydration no longer depend on adapter heuristics such as guessing `name`, `title` or `summary`. The same projection is used for lookup search/pagination and batch resolution, falls back to stable record ID when no usable label value exists, and additionally requires current target-model read authority to prevent cross-model label disclosure. Kernel `0.24.0` also projects a minimal current human-readable Space label alongside an already-authorized Runtime Discovery Space reference, so n8n, MCP, Agents and generated UI can present the same Space without acquiring Space membership-management metadata or authority. Kernel `0.25.0` adds bounded standard Capability field-role bindings to the same projection, beginning with Calendar timed/all-day field roles; these bindings expose reusable semantics without promoting adapter UI layout into platform truth. Kernel `0.26.0` separates the Static Semantic Plane from dynamic visibility by adding `GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}`: Space is only a current visibility gate, while a successful semantic body is authority-independent and cacheable within one Kernel representation by `(key, version, schemaHash)`; a cache that survives Kernel deployment additionally keys by Kernel `contractVersion`; missing and currently invisible models share an opaque 404, and execution still rechecks current authority. Kernel `0.27.0` adds `GET /api/v1/me/_discovery/inventory` as the compact Dynamic Visibility Plane: coarse static Model/Action/Capability facts are de-duplicated once, each reachable Space carries only minimal `modelKey + effective access` edges, and heavyweight field/default/query/action-input/Capability-binding semantics are loaded progressively through the 0.26 detail route. The older full Discovery surfaces remain available for compatibility and are never authorization proof.

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
verified authenticated principal context
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
(Access iss, Access sub) -> global usr_*
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

Both authenticate the current `service` principal representation and are bounded by application/service scope ceilings, Application × Model Access, current Data Grants and model policy.

`lsa_*` is a different credential: it authenticates a trusted application backend to Identity and does not itself represent a service principal to Core.

The same Identity/Core ownership applies to passive Eventing subscribers. Identity remains authoritative for whether the subscriber Service Principal and owning application are active; Core remains authoritative for Eventing Endpoint/Subscription state, Application × Model Access and Data Grants. The final Webhook delivery gate composes those two sources through an authenticated Core -> Identity Service Binding read rather than copying Identity status into Core. Principal disablement therefore remains effective even if an application partially fails to revoke its Core Grant during cleanup.

The Core-only current-principal eligibility read is an internal runtime interface used to enforce already-declared revocation semantics. It is not application-callable business syntax and does not by itself broaden the Identity Application Contract consumed by HomeMew/ALOHA.

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

Privileged mutations record both identities/roles:

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
  current business-facing contract: 0.6.0

Platform Admin Control-Plane Contract
  apps/identity/platform-admin.openapi.yaml
  independent companion contract: 0.2.0
```

### Core

```text
Kernel Contract
  apps/core/openapi.yaml
  explicit product-facing Space / Grant / Runtime Discovery / Change History / Creation Draft primitives
  current Kernel contract: 0.36.0

Integration / Eventing Contract
  apps/core/integration-eventing.openapi.yaml
  Webhook Endpoint / Event Subscription / delivery + signed outbound Webhook representation
  independent public companion contract: 0.1.0
  executed by the same Core Worker; not part of the Kernel version/fingerprint

Model Control Plane Contract
  apps/core/model-control-plane.openapi.yaml
  independent governance contract: 0.2.0

Platform Admin Control-Plane Contract
  apps/core/platform-admin.openapi.yaml
  independent companion contract: 0.2.0

Model Contract Revision
  mct_<sha256>
  concrete published ordinary-model CRUD/query/action/Capability contract
```

The separate Model Control Plane prevents Model Registry governance and optional AI proposal syntax from being pinned by ordinary Runtime consumers. The independent Integration/Eventing contract does the same for Webhook/Eventing representation: Runtime-only consumers pin Identity/Core Kernel/Model semantics without Eventing, while consumers that use Eventing add its version. The separate Platform Admin contract prevents Console-only privileged APIs from forcing unrelated HomeMew/ALOHA business-contract pin changes. All three contract families may still execute through the same Core Worker without sharing a compatibility lifecycle.

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
- Entity type and operation role must not be conflated: Principal authority and Actor execution remain distinguishable when they differ.
- An Agent does not inherit a user's authority merely by executing an operation for that user.
- Every ordinary record has exactly one source Space.
- Spaces remain distinct under sharing; Grants share authority without changing ownership.
- No shared parent-domain authentication cookie.
- No application authority inferred from hostname.
- No arbitrary executable code/SQL in Model metadata.
- No service credential or platform-admin executor becomes a hidden Space member.
- No browser receives Access/LifeSpace/actor/executor/backend/bootstrap bearer material.
- No Cloudflare Access session alone equals LifeSpace platform-admin authority.
- No privileged Console mutation may replace the signed human actor proof with an unsigned identity field.
