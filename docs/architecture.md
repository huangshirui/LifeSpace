# LifeSpace Architecture

## Purpose

LifeSpace is a shared, metadata-driven life-data platform for ALOHA, HomeMew, and future vertical applications. Applications present different product experiences over one LifeSpace user identity and authorization model and one set of shared Space-owned records.

Ordinary business models are configuration interpreted by a fixed Generic Runtime. New Core source code should normally represent a reusable platform Engine/Capability or a Kernel concern, not one more handwritten domain CRUD implementation.

## Runtime boundaries

```text
Web App browser
  -> same-origin App BFF
  -> Cloudflare Service Binding
  -> LifeSpace Core

Mini Program / untrusted client
  -> short-lived app-scoped bearer token
  -> LifeSpace Core

Owner-controlled n8n / script / MCP / backend
  -> opaque Service API Token
  -> LifeSpace Core

Third-party or policy-controlled service
  -> OAuth client_credentials
  -> short-lived bearer token
  -> LifeSpace Core

Application-specific external login
  -> application adapter/BFF resolves external identity
  -> LifeSpace user_id
  -> authenticated backend token exchange with LifeSpace Identity
```

Platform services:

- `apps/core`: modular-monolith business platform. Owns Spaces, Data Grants, Model Registry, Generic Resource Runtime, reusable business Engines/Capabilities, business authorization, aggregate `/me` views, business migrations and domain event/webhook behavior.
- `apps/identity`: global LifeSpace user registry and credential issuer. Owns `usr_*` users, trusted application registration/credentials, service principals, opaque Service API Token lifecycle, short-lived token issuance/revocation and signing-key lifecycle.

## Core internal architecture

```text
Request
  -> authentication
  -> Kernel route OR model route resolution
  -> Model Registry
  -> current Space/Data Grant + credential authorization
  -> model policy
  -> schema/relation validation
  -> Generic Runtime
  -> Capability hooks
  -> generic/capability storage
  -> audit/response
```

### Kernel

Kernel concepts remain explicit and cannot be created as ordinary user-defined models:

- Identity/Application/Principal and credential state;
- Space, Membership and Space Person;
- Data Grant and authorization state;
- Model Registry administration and publication state;
- Registry-driven Creation Draft orchestration;
- security/signing/deployment state.

The checked-in `apps/core/openapi.yaml` describes only this explicit Kernel surface. Ordinary model endpoints are not manually copied into the Kernel contract.

### Model Registry

Published Model Definitions are the logical source of truth for ordinary business-model schema. They are validated, immutable by version, schema-hashed and compatibility classified.

AI Admin may propose definitions, but it has no arbitrary DDL/code execution path. Publication always uses the same validator and registry as every other model change.

Each successful publish/retire activates an immutable content-addressed Model Contract Revision containing the concrete model OpenAPI/JSON Schema generated from Registry + Capability metadata.

### Generic Resource Runtime

Ordinary Space-owned records use one fixed runtime for schema validation, declarative defaults, CRUD, query, pagination, relation integrity, optimistic concurrency, soft deletion and actor audit.

Generic JSON persistence is permitted only behind this runtime and a published definition. There is no schemaless resource API.

### Engines and Capabilities

Reusable Engines/Capabilities add semantics that should not be encoded as arbitrary model code. Current Phase-3 proving set includes:

- Policy;
- Workflow/actions, including bounded state/relation-aware branches;
- Calendar;
- Temporal/Cycle;
- AI Interpretation / Registry-driven Creation Draft;
- Async Job / Queue orchestration.

Capabilities may own auxiliary persistence/indexes where generic storage would weaken correctness or query performance. They also own deterministic contract contributions so Runtime semantics and `mct_*` remain aligned.

## Contract boundary

Core has two independently versioned contract layers:

```text
Kernel Contract
  apps/core/openapi.yaml
  explicit Space / Membership / Grant / Model Admin / Creation Draft APIs

Model Contract Revision
  mct_<sha256>
  concrete published model CRUD/query/action/Capability APIs
```

A client release pins a compatible pair rather than treating the active Registry as an unversioned build contract. Core Kernel `0.12.0` is the first checked-in contract after this split; the former Phase-2 `0.11.0` combined-domain OpenAPI is no longer the target architecture.

## Identity boundary

LifeSpace Identity is authoritative for the LifeSpace `user_id`, not for every external provider account used by every application.

Application-owned mappings stay in the application boundary:

```text
HomeMew WeChat Cloud Function
  openid -> LifeSpace user_id

School Mini Program adapter
  its WeChat/provider identity -> LifeSpace user_id

Other vertical app adapter
  provider-specific identity -> LifeSpace user_id
```

Core never stores or authenticates WeChat `openid`, WeCom `userid`, or equivalent external application IDs.

A trusted application backend authenticates to Identity with its own revocable application credential and may create/resolve LifeSpace users through approved Identity flows. Browser or Mini Program clients must never be allowed to submit an arbitrary `user_id` directly to token issuance endpoints.

## Service and automation authentication

The deployed service-authentication model remains authoritative. See `docs/service-authentication.md`.

- owner-controlled trusted backends may use opaque, revocable `lsp_pat_*` Service API Tokens;
- third-party/policy-controlled services may use OAuth `client_credentials` short-lived JWTs.

Both normalize to a service Principal and remain subject to current credential/application authority, Data Grant and model policy. Possessing a credential alone grants no Space data access.

## Data ownership

Every ordinary business record belongs to exactly one source Space. A Space may represent a personal, family, team, or future approved context.

Cross-Space sharing uses Data Grants or approved derived views. Sharing does not copy or move the source record.

## Applications

ALOHA, HomeMew and vertical applications are clients, not data owners. App repositories own UI, app-specific navigation, local presentation state, external-provider identity mapping, provider secrets and optional BFF aggregation. They must not become parallel sources of truth for platform business data.

## Cloudflare deployment

Target production topology:

- `auth.aisr.online` -> Identity Worker
- `core.aisr.online` -> Core Worker
- application domains -> their own application Worker/Pages deployment and optional same-origin BFF

Production and staging use separate Workers and separate D1/R2/Queue resources.

## Phase-2 domain convergence

Phase 2 established verified semantics for Event, Task, Day Record, Wish and Creation Draft. HomeMew never cut over to that intermediate domain runtime, so Phase 3 used those implementations only as golden semantic references.

The target Core source has now converged to:

```text
Task       -> Model Definition + Generic Runtime + Workflow
Wish       -> Model Definition + Generic Runtime + Policy + Workflow
Day Record -> Model Definition + Generic Runtime + Temporal
Event      -> Model Definition + Generic Runtime + Calendar
Creation Draft -> Registry-driven AI Interpretation + Async Job
```

The handwritten Event/Task/Day Record/Wish services and fixed four-kind Creation Draft implementation have been removed. The old dedicated domain tables are dropped by destructive staging convergence migrations while historical migrations remain as audit evidence.

HomeMew client/data migration remains paused until the remaining Phase-3 AI Admin work and staging verification complete.
