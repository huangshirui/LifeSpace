# LifeSpace Architecture

## Purpose

LifeSpace is a shared, metadata-driven life-data platform for ALOHA, HomeMew, and future vertical applications. Applications present different product experiences over one LifeSpace user identity and authorization model and one set of shared Space-owned records.

Ordinary business models are configuration interpreted by a fixed Generic Runtime. New Core source code should normally represent a reusable platform Runtime/Engine/Capability/physical-schema concern or a Kernel concern, not one more handwritten domain CRUD implementation.

Metadata-driven logical modeling is independent from physical persistence. Ordinary models remain dynamically publishable through Model Definitions while the final Phase-3 physical representation uses deterministic typed model tables rather than a universal JSON business-data table.

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

- `apps/core`: modular-monolith business platform. Owns Spaces, Data Grants, Model Registry, Runtime Model Descriptor cache, Physical Schema Compiler, Generic Resource Runtime, reusable business Engines/Capabilities, business authorization, aggregate `/me` views, Kernel/business migrations and domain event/webhook behavior.
- `apps/identity`: global LifeSpace user registry and credential issuer. Owns `usr_*` users, trusted application registration/credentials, service principals, opaque Service API Token lifecycle, short-lived token issuance/revocation and signing-key lifecycle.

## Core internal architecture

```text
Request
  -> authentication
  -> Kernel route OR model route resolution
      -> Worker-isolate Runtime Model Descriptor snapshot
      -> D1 Registry only on cache load/refresh or admin path
  -> current Space/Data Grant + credential/application authorization
  -> model policy
  -> schema/relation validation
  -> Generic Runtime
  -> Capability hooks
  -> typed model / relation / capability storage
  -> audit/response
```

Stable model rules are compiled/cached; revocable authorization state remains current-state checked.

### Kernel

Kernel concepts remain explicit and cannot be created as ordinary user-defined models:

- Identity/Application/Principal and credential state;
- Space, Membership and Space Person;
- Data Grant and authorization state;
- Model Registry administration and publication state;
- Registry-driven Creation Draft orchestration;
- security/signing/deployment state.

The checked-in `apps/core/openapi.yaml` describes only this explicit Kernel surface. Ordinary model endpoints are not manually copied into the Kernel contract.

### Model Registry and Runtime Model Descriptors

Published Model Definitions are the logical source of truth for ordinary business-model schema. They are validated, immutable by version, schema-hashed and compatibility classified.

AI Admin may propose definitions, but it has no arbitrary DDL/code execution path. Publication always uses the same validator and Registry as every other model change. Physical DDL is produced only by the fixed Physical Schema Compiler from validated metadata and an approved compatibility/migration plan.

D1 Registry is durable authority. Normal ordinary-model business requests do not read and revalidate the Registry row on every request. A Worker isolate loads the published set, validates it and compiles Runtime Model Descriptors indexed by model key and route. Cache loss is safe because D1 can repopulate the snapshot; publication/retirement invalidates the local snapshot and bounded refresh handles other isolates.

Runtime Model Descriptors precompute stable route/field/query/relation/access metadata. Membership, Data Grants, Application × Model Access and other mutable authority are not long-lived cached as part of that snapshot.

Each successful publish/retire activates an immutable content-addressed Model Contract Revision containing the concrete model OpenAPI/JSON Schema generated from Registry + Capability metadata.

### Physical Schema Compiler

The Physical Schema Compiler converts a validated Model Definition into deterministic storage metadata and bounded DDL. It is platform code, not generated per-model application code.

Target physical shape:

```text
resource_records
  common record identity / Space ownership / model version
  optimistic version / actor audit / timestamps / soft delete

mdl_<model_key>
  record_id -> resource_records.id
  duplicated space_id for query locality
  typed scalar business columns
  generated query indexes

resource_relations
  person / record relation values and ordered relation-list values

Capability projections
  Calendar / Temporal / future capability-specific storage/indexes
```

Initial model publication may create its typed table/indexes without a repository commit or Worker deployment. Compatible additive changes may add safely representable columns/indexes. Changes requiring data rewrite/backfill are rejected until an explicit physical migration plan is available. Kernel/Identity deployment schema continues to use repository-owned migrations.

### Generic Resource Runtime

Ordinary Space-owned records use one fixed runtime for schema validation, declarative defaults, CRUD, query, pagination, relation integrity, optimistic concurrency, soft deletion and actor audit.

The initial `resource_records.data_json` / `resource_index_values` implementation was a Phase-3 proving representation. Before HomeMew cutover, ordinary scalar CRUD/query converges to generated typed model tables while `resource_records` remains the common record envelope/catalog and `resource_relations` remains shared relation storage. There is never a schemaless resource API.

Generic Runtime query execution uses compiled validated identifiers and typed columns/indexes rather than arbitrary SQL supplied by metadata or clients.

### Runtime performance invariants

HomeMew production measurements showed that repeated Worker↔D1 calls and N+1 entity hydration dominate avoidable latency while individual D1 SQL execution is already very small. LifeSpace therefore treats D1 network round trips as a first-class request budget.

Normative detail is in `docs/phase3-performance-convergence-plan.md`. In particular:

- hot-cache ordinary model route resolution performs zero Model Registry D1 reads;
- list/query response mapping must not perform D1 I/O per returned record;
- shared Space/Person/Capability context is loaded once or batch-hydrated;
- mutable authorization checks may be combined/batched but may not lose immediate revocation semantics;
- Workers KV, Cache API or Durable Object Registry reads are not introduced without measured evidence that isolate memory + D1 fallback is insufficient.

### Engines and Capabilities

Reusable Engines/Capabilities add semantics that should not be encoded as arbitrary model code. Current Phase-3 proving set includes:

- Policy;
- Workflow/actions, including bounded state/relation-aware branches;
- Calendar;
- Temporal/Cycle;
- AI Interpretation / Registry-driven Creation Draft;
- Async Job / Queue orchestration.

Capabilities may own auxiliary persistence/indexes where the ordinary typed model table would weaken correctness or query performance. They also own deterministic contract contributions so Runtime semantics and `mct_*` remain aligned.

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

Physical table names and other storage implementation details are not public model contract surface.

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

A typed model table may duplicate `space_id` solely for query locality/indexing; that duplicate does not create another ownership source.

## Applications

ALOHA, HomeMew and vertical applications are clients, not data owners. App repositories own UI, app-specific navigation, local presentation state, external-provider identity mapping, provider secrets and optional BFF aggregation. They must not become parallel sources of truth for platform business data.

## Cloudflare deployment

Target production topology:

- `auth.aisr.online` -> Identity Worker
- `core.aisr.online` -> Core Worker
- application domains -> their own application Worker/Pages deployment and optional same-origin BFF

Production and staging use separate Workers and separate D1/R2/Queue resources.

Publishing or compatibly extending an ordinary model after typed-storage convergence does not itself require a Worker deployment. Kernel/Runtime/Capability code changes still use the normal repository deployment process.

## Phase-2 / Phase-3 domain convergence

Phase 2 established verified semantics for Event, Task, Day Record, Wish and Creation Draft. HomeMew never cut over to that intermediate domain runtime, so Phase 3 used those implementations only as golden semantic references.

The logical target Core source has converged to:

```text
Task       -> Model Definition + Generic Runtime + Workflow
Wish       -> Model Definition + Generic Runtime + Policy + Workflow
Day Record -> Model Definition + Generic Runtime + Temporal
Event      -> Model Definition + Generic Runtime + Calendar
Creation Draft -> Registry-driven AI Interpretation + Async Job
```

The handwritten Event/Task/Day Record/Wish services and fixed four-kind Creation Draft implementation have been removed. Phase 3 performance/physical-storage convergence now replaces the intermediate universal JSON/index persistence with generated typed model storage while preserving those logical abstractions and semantic tests.

HomeMew client/data migration remains paused until Phase 3 typed-storage/performance convergence and final staging verification complete.
