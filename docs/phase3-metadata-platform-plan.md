# Phase 3 — Metadata-driven / AI-native LifeSpace Platform

Updated: 2026-08-11

## 1. Decision

Phase 2 is complete. Before HomeMew migrates any client or production data to LifeSpace, LifeSpace will change its business-domain architecture from one handwritten implementation per domain to a metadata-driven platform runtime.

The target invariant is:

> Adding an ordinary LifeSpace business model must not require modifying Core runtime source code.

New runtime code should normally be required only when LifeSpace gains a new reusable platform capability, not when it gains another ordinary domain model.

This Phase deliberately changes the Phase-2 target domain architecture before HomeMew cutover. There is no compatibility requirement for the Phase-2 Event/Task/Day Record/Wish persistence or public domain contract because no HomeMew production traffic or durable HomeMew data has migrated to LifeSpace yet.

Identity, Space, Membership, Space Person, Data Grant, service authentication, R2, Queue, rate-limit, environment isolation, request tracing and the deployment foundation remain platform assets and are not being rebuilt.

## 2. Architecture target

```text
LifeSpace
├── Kernel
│   ├── Identity / Application / Principal
│   ├── Space / Membership / Space Person
│   ├── Data Grant / authorization
│   ├── JWT / Service API Token / OAuth
│   ├── audit actor / tracing
│   └── environment/deployment security
│
├── Model Platform
│   ├── Model Definition DSL
│   ├── Model Registry
│   ├── Model Version / publish lifecycle
│   ├── Generic Resource Storage
│   ├── Relation / index projection
│   ├── Generic CRUD / query / pagination
│   ├── schema validation
│   └── contract generation
│
├── Generic Engines
│   ├── Policy
│   ├── Workflow / actions
│   ├── computed fields
│   └── trigger/event execution
│
├── Capabilities
│   ├── Calendar
│   ├── Temporal / Cycle
│   ├── Asset
│   ├── AI Interpretation
│   └── Async Job
│
└── Model Definitions
    ├── event
    ├── task
    ├── day_record
    ├── wish
    └── future models without Core source changes
```

## 3. Safety principles

### 3.1 Metadata is executable configuration, not arbitrary code

Model definitions are validated against a closed, versioned DSL. Model definitions may not contain arbitrary JavaScript, SQL, Worker code, shell commands or unrestricted expressions.

AI Admin may propose model definitions but may never execute arbitrary DDL or arbitrary runtime code. Publication flows through the same validator and registry as every other model change.

### 3.2 Registry is the source of truth

The logical model schema is the published Model Registry definition, not the physical D1 representation.

OpenAPI/JSON Schema, runtime validation, route registration, query semantics, authorization requirements and AI draft schemas are derived from the published registry and capability definitions.

### 3.3 Generic storage is strongly governed

Generic JSON persistence is allowed only behind a published model definition and the generic runtime. Clients cannot write undeclared fields. Required fields, types, relations, lifecycle, authorization and capability invariants are validated before persistence.

Capabilities may own auxiliary tables/indexes when generic storage cannot efficiently or correctly represent their semantics.

### 3.4 Kernel data is not an ordinary model

Identity, applications, credentials, Space, membership, Space Person, Data Grant, model-registry administration and signing/security state remain explicit Kernel concepts. They cannot be created as ordinary user-defined resource models.

### 3.5 No compatibility burden before HomeMew cutover

Phase-2 domain tables/routes may be removed or replaced destructively in staging. No dual-read, dual-write, backfill bridge or legacy LifeSpace domain compatibility facade is required.

HomeMew migration transforms will be updated only after the new target model runtime is stable.

## 4. Model Definition v1

The first DSL is intentionally small. It must be powerful enough to express ordinary records while resisting becoming a second general-purpose programming language.

Required model metadata:

- stable `key`;
- `route` segment;
- display singular/plural names;
- model definition version;
- field definitions;
- query/search definitions;
- authorization/scopes;
- lifecycle features such as optimistic concurrency and soft deletion;
- enabled capabilities;
- optional workflow actions and policy expressions once those engines exist.

Initial field types:

- `string`, `text`;
- `integer`, `number`;
- `boolean`;
- `date`, `datetime`, `timezone`;
- `enum`;
- `person`, `person_list` for same-Space Space Person references;
- `record`, `record_list` for typed model references;
- `json` only for explicitly bounded capability-owned payloads, not as an escape hatch for undeclared schemas.

Field constraints include required/nullable, min/max, string length, enum values, uniqueness where supported, immutable/read-only flags and relation target constraints.

## 5. Model lifecycle

```text
draft
  -> validate
  -> publish
  -> active
  -> superseded / retired
```

Published definitions are immutable. A change creates a new version.

Validation must reject at least:

- invalid/reserved model keys or route segments;
- duplicate fields;
- unsupported field/capability types;
- incompatible relation targets;
- unsafe or unknown policy/workflow operators;
- route collisions with Kernel APIs;
- destructive schema changes without an explicit migration classification;
- contract generation collisions.

A model publication records actor, timestamp, schema hash and compatibility classification.

## 6. Generic API target

Kernel routes remain explicit.

Published ordinary models receive generated domain-shaped routes backed by one runtime implementation:

```text
GET    /api/v1/spaces/{spaceId}/{modelRoute}
POST   /api/v1/spaces/{spaceId}/{modelRoute}
GET    /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
PATCH  /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
DELETE /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
```

Workflow actions later use:

```text
POST /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}/actions/{actionKey}
```

The route is resolved to a published model definition; the runtime never dispatches to generated source files.

Cross-Space `/api/v1/me/...` aggregate support is model metadata/capability driven and is added after the single-Space runtime is stable.

## 7. Storage target

Initial generic storage:

- `model_definitions` / immutable published model versions;
- `resource_records` for ordinary model records;
- `resource_relations` for validated relation projections;
- `resource_index_values` for declared searchable/filterable/sortable projections where needed;
- audit metadata either in resource rows plus the existing audit pattern or a generic append-only audit table when required.

Every resource row keeps exactly one `space_id`, model key/version, optimistic version, actor snapshots, timestamps and soft-delete state.

Capability-specific auxiliary persistence is allowed when it protects semantics or performance. Calendar and Temporal are expected to need auxiliary projections rather than forcing every concern into `data_json`.

## 8. Authorization target

Existing effective authorization remains authoritative:

```text
verified principal
∩ current membership/Data Grant
∩ credential/application authorization
∩ model policy
```

Phase 3 introduces a Model Scope Catalog so a model can declare read/write/manage capability without source-code registration.

The implementation must not weaken current immediate membership/Grant/token revocation semantics.

Model administration is platform administration, not an ordinary Space write. The first admin API must be service-only and require an explicit platform model-management scope. A normal app/member must never be able to publish model definitions merely because it can manage one Space.

## 9. Policy / Workflow v1

The expression language is closed and deterministic. No `eval`, arbitrary JavaScript or SQL.

Initial context:

- `$actor`;
- `$space`;
- `$record`;
- `$input`;
- `$now`.

Initial operators cover equality/inequality, boolean composition, null checks, enum/state checks, actor/record Person comparison and simple bounded value comparison.

Workflow actions may perform validated record-field assignments, actor/time assignments and state transitions. Cross-resource triggers are deferred until the single-record action engine is proven.

## 10. Capability extraction

### Calendar

Owns timed/all-day semantics, IANA timezone validation, DST-safe handling, interval overlap query and later recurrence/free-busy.

### Temporal / Cycle

Owns elapsed/countdown/cycle calculations, Space-timezone date semantics, occurrence history and cycle advancement.

### Asset

Generalizes safe R2 object ownership/replacement while preserving service-owned namespaces and stable public read URLs.

### AI Interpretation

Creation Draft becomes registry-aware. It receives the set of model definitions/capability schemas currently enabled for the calling application instead of hard-coding Event/Task/Day Record/Wish form schemas.

### Async Job

Creation Draft Queue/TTL/retry/rate-limit infrastructure is generalized without making generic CRUD asynchronous.

## 11. Contract strategy change

`apps/core/openapi.yaml` remains a reproducible published Core contract artifact, but ordinary model paths/schemas stop being manually authored as independent sources of truth.

The canonical inputs become:

1. explicit Kernel API definitions;
2. published Model Registry definitions;
3. registered Capability contract contributions.

A deterministic generator produces the versioned OpenAPI/JSON Schema publication surface. CI fails if generated artifacts drift.

Applications continue to pin explicit compatible contract versions; dynamic models do not mean clients consume an unversioned moving contract.

## 12. Implementation slices

### 3.0 — Direction reset and normative architecture

- Update root/Core AGENTS rules.
- Update architecture, permissions and contract strategy.
- Insert this platform phase before HomeMew client migration.
- Freeze new handwritten domain expansion.

Exit: repository instructions unambiguously authorize the metadata runtime and forbid adding another ordinary handwritten domain unless it is an approved capability/kernel exception.

### 3.1 — Model Definition + Registry

- Define TypeScript DSL and validator.
- Add D1 model-definition/version tables.
- Add reserved routes and schema hashing.
- Add service-only model admin read/draft/publish APIs.
- Seed Task as the first published model definition.
- Add registry unit/integration tests.

Exit: a validated Task definition can be published/read without adding a Task runtime route implementation.

### 3.2 — Generic Resource Storage + CRUD

- Add `resource_records` and relation/index projections.
- Implement generic create/get/update/delete/list/query runtime.
- Implement optimistic concurrency, soft delete, actor snapshots, stable errors and pagination.
- Add same-Space Person relation validation.
- Route published model paths into the generic runtime.

Exit: Task CRUD works solely through its model definition and Generic Runtime.

### 3.3 — Model authorization + Scope Catalog

- Add model read/write/manage declaration and runtime scope resolution.
- Integrate current membership/Data Grant evaluation.
- Add application/model access catalog or equivalent constrained scope mechanism without weakening Identity ceilings.
- Verify immediate revocation behavior for user/service access.

Exit: dynamically published models have explicit app/credential and Space authorization without source changes.

### 3.4 — Policy + Workflow + computed fields

- Implement safe expression AST/validator/evaluator.
- Implement record actions and state transitions.
- Add computed-field hooks needed by current baseline.
- Express Task complete/reopen with configuration.
- Express Wish lifecycle/policies as the second validation model.

Exit: Task and Wish have no handwritten domain runtime.

### 3.5 — Contract generator

- Split explicit Kernel contract inputs from generated model contributions.
- Generate OpenAPI paths/schemas/action contracts from Registry fixtures/build definitions.
- Generate/publish JSON Schema and client types.
- Replace current manual domain contract checks with reproducibility/drift checks.

Exit: adding a fixture/model definition changes the generated contract without handwritten OpenAPI domain edits.

### 3.6 — Calendar + Temporal capabilities

- Extract Calendar semantics from Phase-2 Event behavior.
- Extract Temporal/Cycle semantics from Phase-2 Day Record behavior.
- Add capability validator/query hooks and auxiliary persistence as required.
- Express Event and Day Record as model definitions plus capabilities.

Exit: Event/Task/Day Record/Wish baseline semantics execute through Generic Runtime + reusable capabilities.

### 3.7 — Registry-driven Creation Draft

- Remove hard-coded four-kind draft contract/runtime assumptions.
- Build allowed AI schema from published models and application exposure.
- Keep Queue retry/claim/TTL/privacy/rate-limit semantics.
- Preserve user-only interactive authorization unless deliberately changed.

Exit: publishing a simple new model makes it eligible for AI interpretation without changing Creation Draft source code.

### 3.8 — Native convergence / destructive cleanup

Because HomeMew has not migrated:

- remove Phase-2 handwritten Event/Task/Day/Wish runtime files;
- retire replaced dedicated domain tables/routes/contracts;
- remove obsolete migration transforms that target the discarded intermediate schema, while preserving historical Phase-2 evidence where useful;
- reset/rebuild staging Core D1 as needed rather than carrying compatibility migrations;
- run full Kernel + four-domain semantic + service-auth + Queue staging E2E.

Exit: no supported ordinary domain depends on a handwritten CRUD service.

### 3.9 — AI Admin

- Implement service-only Model Admin API over Registry draft/validate/diff/publish.
- Add AI model designer that produces definitions, never DDL/code.
- Show security/contract/storage diff before publication.
- Add rollback/supersede/retire controls.
- A visual Admin UI is a separate product surface and is not required for Core platform exit unless explicitly promoted to a blocker.

Exit: a model can be described in natural language, reviewed as a structured diff, published through Registry and immediately used by Generic Runtime.

## 13. Implementation order / proving strategy

Do not attempt Event first.

Use increasing complexity:

```text
Task
  -> Wish
  -> Day Record
  -> Event
  -> Creation Draft genericization
```

Task proves ordinary CRUD + relation + workflow.
Wish proves record-level policy and richer lifecycle.
Day Record proves Temporal capability.
Event proves Calendar capability and complex query semantics.

The Phase-2 semantic tests are golden behavior references, not persistence/API compatibility requirements.

## 14. Phase 3 exit gate

- [ ] Ordinary models can be added/published without modifying Core runtime source.
- [ ] Published model definitions are immutable/versioned and schema-hashed.
- [ ] Generic Runtime enforces schema, same-Space ownership, authorization, concurrency and soft deletion.
- [ ] Model authorization works for users and service principals without weakening Data Grant/token revocation.
- [ ] Generated OpenAPI/JSON Schema is reproducible from Kernel + Registry + Capability inputs.
- [ ] Task and Wish run with Model Definition + Generic Engines only.
- [ ] Day Record runs through the Temporal capability.
- [ ] Event runs through the Calendar capability.
- [ ] Creation Draft discovers supported models from Registry rather than a four-kind hard-coded union.
- [ ] Phase-2 handwritten domain runtime is removed from target Core.
- [ ] Staging passes Kernel, Identity, service-auth, R2, Queue and four-domain semantic E2E on the new architecture.
- [ ] HomeMew migration transforms and client contract are regenerated against the new platform only after the target architecture is stable.

## 15. HomeMew sequencing impact

HomeMew native client migration and production data migration are paused until this Phase exits.

This is intentional: adapting HomeMew to Core `0.11.0` and then immediately migrating it again to a metadata-runtime contract would create avoidable client and data migration work.

After Phase 3, HomeMew will pin the new generated Core contract and migration tooling will transform the HomeMew source snapshot directly into the final metadata-driven target instead of into the discarded Phase-2 intermediate domain schema.
