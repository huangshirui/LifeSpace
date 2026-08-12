# Core Agent Instructions

LifeSpace Core is the shared business API and source of truth for Spaces, Data Grants, the Model Registry and metadata-driven life-domain records.

## Before changing Core

Read:

1. Root `AGENTS.md`
2. `docs/architecture.md`
3. `docs/permissions.md`
4. `docs/service-authentication.md` when changing service or machine authentication
5. `docs/contracts.md`
6. `docs/phase3-metadata-platform-plan.md` when changing model/runtime architecture
7. `docs/phase3-performance-convergence-plan.md` when changing ordinary-model storage, Registry runtime lookup, query hydration, authorization I/O, or performance-sensitive request paths
8. `docs/migration-plan.md` when porting HomeMew behavior
9. Core contract, Model Definitions, migrations, tests and relevant implementation

## Core responsibilities

Core owns:

- Spaces and Space membership.
- Data Grants and current authorization evaluation.
- Model Definition validation, Model Registry/version lifecycle and model administration.
- Generic Resource storage/runtime for ordinary Space-owned business models.
- Reusable Engines such as Policy/Workflow/computed fields as they are implemented.
- Reusable Capabilities such as Calendar, Temporal/Cycle, Asset, AI Interpretation and Async Job as they are approved and implemented.
- Cross-Space aggregate `/me` views.
- Runtime validation, concurrency, soft deletion, audit fields, relation integrity, search/filter semantics and lifecycle cleanup.
- Reproducible canonical Core OpenAPI/JSON Schema and business D1 migrations.

Core does not own:

- External provider login or SSO browser sessions.
- WeChat `openid`, Google subject IDs, email OTP flows or other provider-specific authentication mappings.
- Application UI state or application-specific navigation.
- A second copy of application BFF session state.
- Arbitrary executable user code/SQL inside Model Definitions.

## Metadata-driven domain rules

- Ordinary models are declared through the closed Model Definition DSL and interpreted by fixed Generic Runtime code.
- Do not add another handwritten ordinary-domain CRUD router/service/table when the requirement can be represented by Model Definition or a reusable Capability.
- If a requirement cannot be represented, first decide whether the gap belongs in a reusable Engine/Capability. Add source code at that reusable boundary, not at a one-off model boundary.
- Model Definitions are immutable once published; changes create a new version and explicit compatibility classification.
- Registry logical schema is authoritative. Metadata-driven logical schema does **not** require a universal JSON physical-storage table. During Phase 3 performance convergence, ordinary scalar fields move to deterministic generated `mdl_<model_key>` typed tables while common record identity/audit remains generic and relation/capability projections remain shared.
- Physical model tables/columns/indexes are generated only from validated Model Definitions by fixed platform code. Never add handwritten per-model DDL as the normal ordinary-model extension path, and never execute AI/client-provided SQL.
- Kernel routes and model routes must never collide. Reserved routes are enforced by Model Definition validation.
- Model metadata cannot contain arbitrary JavaScript, SQL, shell code or unrestricted expressions.

## Runtime performance rules

- D1 Model Registry remains authoritative durable state, but a normal hot-cache ordinary business request must resolve published model metadata from the Worker-isolate runtime Registry snapshot rather than querying `model_definitions` per request.
- Compile stable model lookup/query/relation/access metadata once per runtime Registry snapshot; do not repeatedly parse and validate the same published `definition_json` on each business request.
- Cache only stable model/runtime rules. Membership, Data Grants, Application × Model Access and other revocable authority remain current-state authorization checks and must not be hidden behind a long-lived metadata cache.
- Result mapping/hydration must not perform D1 I/O per returned record. Any D1 query inside a loop/`map` over query results is an N+1 defect unless explicitly bounded and justified.
- Load shared Space/Person/Capability context once per request or response where possible; batch relation/person hydration instead of resolving the same entity repeatedly.
- Prefer reducing Worker↔D1 round trips over micro-optimizing already-sub-millisecond SQL. Use D1 `batch()` when multiple statements can safely share one database call without weakening authorization or transaction semantics.
- Design against the budgets in `docs/phase3-performance-convergence-plan.md`: hot-cache ordinary single GET <= 4 D1 round trips, list/query <= 5 independent of result count, mutation <= 6, and Registry hot-path lookup = 0.
- Do not introduce Workers KV, Cache API, Durable Object Registry reads or another distributed cache layer without measured evidence that isolate memory + D1 fallback is insufficient.

## Authorization rules

- Every ordinary business record must have exactly one source `space_id`.
- Every read/write must evaluate authenticated principal, current Space/Data Grant authorization, credential/application authorization and published model policy.
- Never treat `space_id` existence as proof of access.
- Never trust request `userId` as actor identity.
- Cross-Space aggregate endpoints must preserve source Space and effective capability where clients need writable/shared distinction.
- Revoking membership or a Data Grant must take effect from current authorization state; do not rely only on long-lived token claims.
- Core normalizes verified RS256 JWTs and Identity-introspected opaque `lsp_pat_*` tokens into the same principal context; it must not read Identity D1 or persist credential hashes.
- A Service API Token authenticates a service principal only. It must still pass current application scope, Space/Data Grant and model authorization.
- Model Registry administration is platform administration, not an ordinary Space permission. A future admin API must be explicitly service-only and separately scoped.

## HomeMew migration rules

Use HomeMew/Phase-2 Core behavior as semantic reference for Workers/Hono structure, request IDs, response envelopes, optimistic concurrency, soft deletion, time/date semantics, queues, AI privacy boundaries and domain behavior.

Do not mechanically preserve the Phase-2 dedicated Event/Task/Day Record/Wish persistence or routers. Before HomeMew cutover they are proving fixtures for the new Generic Runtime and Capabilities, not compatibility constraints.

Do not mechanically port:

- `family_id` ownership assumptions;
- HomeMew-specific user identity ownership;
- family-only role checks where Space/Data Grant rules are required;
- HomeMew integration permission names when platform scopes should be generalized.

## Persistence

- Core D1 migrations belong under `apps/core/migrations` for Kernel/platform-owned deployment schema. Ordinary model physical schema is produced by the validated Model publication/schema-planning path once Phase 3 typed-storage convergence is active; it must not require a repository migration for every new ordinary model.
- Kernel tables remain explicit.
- Ordinary resources may use generic/shared storage only behind validated published model definitions. The intermediate `resource_records.data_json` / `resource_index_values` representation is not a permanent target after Phase 3 performance convergence.
- Important invariants should be enforced in D1 when cheap and reliable; semantic invariants additionally belong in Registry/Runtime validation.
- Capabilities may own auxiliary tables/indexes when generic storage is insufficient for correctness/performance.
- Avoid schema designs that require application clients to repair referential integrity.
- Migration and Worker rollout order must be compatible and documented.

## Verification

A Core change is incomplete until canonical contract checks, tests, type checks and dry-run build pass. Metadata-platform changes additionally require Model Definition/Registry validation tests, Kernel/model authorization isolation tests and reproducibility checks for generated model contracts once generation is enabled. Performance-convergence changes additionally require deterministic physical-schema tests where applicable and must preserve the request-I/O invariants in `docs/phase3-performance-convergence-plan.md`.
