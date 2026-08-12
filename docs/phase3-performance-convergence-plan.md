# Phase 3 Performance / Physical Storage Convergence

Updated: 2026-08-12

## 1. Purpose

Phase 3 has already proven the metadata-driven direction: ordinary business models are described by Model Definitions and executed by a fixed Generic Runtime instead of handwritten per-domain routers/services.

Before HomeMew client or production-data migration resumes, LifeSpace must converge that logical architecture onto a runtime and physical-storage design that keeps the flexibility benefit without paying avoidable per-request interpretation or D1 round-trip costs.

This plan is a blocking extension of Phase 3, not a post-cutover optimization project.

## 2. Measured HomeMew baseline

Cloudflare production metrics observed for the previous seven days on 2026-08-12:

- HomeMew Core Worker: about 8k invocations.
- Worker request duration: P50 about 339 ms, P90 about 780 ms, P99 about 2 s.
- Worker CPU time: P50 about 12.3 ms, P90 about 25.62 ms, P99 about 45.3 ms.
- HomeMew D1: about 193k total queries for the same period, about 24 queries per Worker invocation on average.
- D1 query latency: P50 about 0.16 ms.
- D1 database size: about 721 KiB, 20 tables.
- The most frequent query, `SELECT display_name,avatar_key FROM users WHERE id=?`, ran more than 100k times and accounts for more than half of observed D1 query count.

The baseline shows that SQL execution and JavaScript CPU are not the primary latency source. Repeated Worker-to-D1 calls and N+1 entity resolution dominate the avoidable cost.

Therefore LifeSpace performance work prioritizes request shape and I/O count before micro-optimizing JavaScript or introducing additional distributed cache products.

## 3. Target architecture decisions

### 3.1 Logical model remains metadata-driven

The existing invariant remains unchanged:

> Adding an ordinary LifeSpace model must not require new handwritten Core runtime source code.

Model Definition / Registry remains the logical source of truth. Generic Runtime, Policy, Workflow and Capability semantics remain shared platform code.

### 3.2 Metadata-driven does not mean universal JSON physical storage

The current `resource_records.data_json` design is an implementation stage, not the final physical-storage invariant.

Target storage is:

```text
resource_records
  -> common record identity / Space ownership / model version
  -> optimistic version / audit / timestamps / soft-delete state

mdl_<model_key>
  -> one row per ordinary resource
  -> typed scalar business columns derived from Model Definition
  -> immutable duplicated space_id for query locality/indexing

resource_relations
  -> person and record relation values, including ordered list relations

Capability-owned projection tables
  -> Calendar / Temporal / future capability-specific query structures
```

`resource_records` remains a generic record catalog/common envelope so cross-model relations and capability foreign keys have one stable target. Ordinary scalar business values move out of `data_json` into generated typed model tables.

No application or AI agent supplies raw DDL. Physical DDL is generated deterministically from a validated Model Definition.

### 3.3 Model publication owns physical schema planning

Publishing a model must not require a GitHub commit, GitHub Action or Worker deployment.

The target flow is:

```text
Model Definition draft
  -> validate
  -> compatibility / dependency checks
  -> deterministic Physical Schema Plan
  -> apply D1 DDL through Core
  -> activate Registry + Model Contract revision
  -> invalidate local runtime metadata snapshot
```

Initial publication may create `mdl_<model_key>` and declared indexes. Compatible additive changes may add columns/indexes. Unsupported destructive/breaking physical changes must fail publication until an explicit safe physical migration plan is available; they must never silently drop or reinterpret durable data.

Kernel/Identity schema changes continue to use repository-owned D1 migrations and normal deployment workflow.

### 3.4 Registry stays authoritative but leaves the normal request hot path

D1 Model Registry remains the durable source of truth.

Ordinary business requests use a Worker-isolate runtime snapshot:

```text
D1 Published Registry
  -> load / validate
  -> compile Runtime Model Descriptors
  -> isolate-memory maps by route and model key
  -> Generic Runtime
```

A compiled descriptor precomputes stable information such as:

- model key/route/version/schema hash;
- declared access capabilities;
- field lookup metadata;
- allowed query parameter set;
- searchable/filterable/sortable field plans;
- relation field plans;
- policy/workflow/capability references required by runtime dispatch.

Normal cache hits perform no Registry D1 query and no repeated `definition_json` parse/validation. Cache loss is safe: the Worker reloads from D1. Cross-isolate freshness may use a short bounded TTL; model publication is low-frequency metadata state and is not treated like immediate credential/membership revocation.

Do not add Workers KV, Cache API or a Durable Object merely to cache Model Registry metadata unless measured evidence later shows isolate memory + D1 fallback is insufficient.

### 3.5 Authorization state is not long-lived metadata cache

The following remain current-state authorization checks and may not be hidden behind a long-lived Registry cache:

- membership;
- Data Grants;
- Application x Model Access;
- credential/token revocation state where applicable.

Optimization should combine or batch these checks to reduce network round trips while preserving current revocation semantics.

Principle:

> Cache/compile stable rules; evaluate mutable authority from current state.

## 4. Request-I/O performance budget

The runtime should be designed against D1 network round trips, not only number of SQL statements. D1 `batch()` is preferred when several independent/current-state statements can be sent in one database call without weakening semantics.

Initial engineering budgets for ordinary hot-cache requests:

- single-resource GET: target <= 4 D1 round trips;
- ordinary list/query: target <= 5 D1 round trips independent of result count;
- ordinary create/update/delete: target <= 6 D1 round trips;
- Model Registry lookup on a hot-cache business request: 0 D1 round trips;
- list response mapping: no per-record D1 queries.

These are design budgets, not permission to add unnecessary queries up to the limit.

Any `for`/`map` over returned records that performs a D1 query must be treated as an N+1 defect unless the operation is explicitly bounded and justified.

## 5. Performance acceptance target

HomeMew's current mixed production workload is the practical reference, not a synthetic theoretical maximum.

Before Phase 4 HomeMew migration resumes, staging must provide comparable workload evidence showing:

- no ordinary endpoint introduces Registry D1 reads on every request;
- list query D1 call count does not grow linearly with returned item count;
- Core CPU remains a minority of request wall time;
- same-semantics LifeSpace request duration does not regress materially against HomeMew;
- target staging P50 for common ordinary-resource reads is <= 220 ms under representative APAC tests, with a stretch goal <= 180 ms;
- P90 common reads target <= 500 ms;
- measured D1 round trips satisfy the budgets above or have an explicit documented exception.

Absolute latency is environment/network dependent, so the final gate uses both request-duration percentiles and counted request-internal D1 calls.

## 6. Implementation slices

### P0 — Performance invariants and baseline

Status: **in progress**.

- Check this plan into the repository.
- Add architecture/Core Agent rules for Registry hot-path caching and N+1 prohibition.
- Preserve the HomeMew Cloudflare baseline above as comparison evidence.
- Define staging benchmark scenarios for Task, Event, Day Record and Wish.

Exit: performance constraints are repository-visible and migration remains blocked on this convergence.

### P1 — Isolate runtime Registry snapshot + compiled descriptors

- Add isolate-memory Registry snapshot keyed by model route and key.
- Load all published definitions together on cold/miss refresh rather than querying one definition per business request.
- Compile stable query/access metadata once per snapshot.
- Use bounded TTL as cross-isolate refresh fallback.
- Invalidate the current isolate snapshot immediately after successful publish/retire.
- Keep direct Registry read APIs for administration/contract generation where current durable state is required.
- Add tests proving cache hit, invalidation and route/key resolution behavior.

Exit: repeated ordinary requests for a published model do not repeatedly read/parse/validate its Registry row.

### P2 — Remove request-path N+1 and redundant Space context reads

- Batch capability response decoration; Temporal Space timezone is loaded once per response, not once per row.
- Add batch relation hydration for list responses before typed-storage cutover requires it.
- Introduce a request-scoped Space/model authorization context where it removes duplicate Space/Space Person reads.
- Group current-state authorization statements with D1 `batch()` where semantics permit.
- Ensure no result mapping function performs D1 I/O per returned record.

Exit: D1 round-trip count for list/query is O(1) with respect to result count.

### P3 — Typed physical schema compiler

- Define deterministic table/column/index naming from validated Model Definition keys.
- Define field-type -> SQLite type mapping.
- Define scalar fields stored in `mdl_<model_key>` and relation fields stored in `resource_relations`.
- Generate a Physical Schema Plan before model activation.
- Support initial table/index creation and compatible additive changes.
- Reject unsupported destructive physical changes with a deterministic error and visible AI Admin diff.
- Add schema-plan reproducibility/collision tests.

Exit: a new ordinary model can obtain typed physical storage without handwritten SQL or a deployment.

### P4 — Generic Runtime typed-storage cutover

- Add typed-row create/get/update/delete/query implementation.
- Keep `resource_records` as common envelope/catalog and `resource_relations` as relation storage.
- Remove ordinary scalar query dependency on `json_extract` and `resource_index_values`.
- Generate SQL only from validated/compiled identifiers and closed field-type mappings.
- Preserve optimistic concurrency, soft delete, relation integrity, Policy/Workflow and Capability behavior.
- Batch-hydrate relations for list responses.

Exit: Task CRUD/query executes through Generic Runtime + typed `mdl_task` storage with no ordinary scalar values read from `data_json`.

### P5 — Four-model convergence and obsolete generic JSON/index cleanup

- Materialize Task, Wish, Day Record and Event into typed model tables in staging.
- Preserve Calendar and Temporal capability-owned projections.
- Run semantic parity tests against existing Phase-3 behavior.
- Remove `resource_index_values` when no supported runtime path depends on it.
- Remove `resource_records.data_json` after all supported model/capability paths have converged.
- Rebuild staging rather than preserve the discarded intermediate data representation when that is simpler and safer before HomeMew cutover.

Exit: all current ordinary models use typed physical tables plus generic relation/capability projections.

### P6 — Authorization round-trip convergence

- Measure remaining per-request D1 calls after P1-P5.
- Collapse Application x Model Access, Space authorization and actor Space Person resolution into the minimum safe set of D1 round trips.
- Preserve immediate membership/Data Grant/application-access revocation semantics.
- Add explicit tests for revocation immediately affecting subsequent requests.

Exit: ordinary endpoint round trips satisfy the budgets in this document.

### P7 — Staging benchmark and Phase 3 closeout

Benchmark at minimum:

- Task single GET and 10-item list;
- Task create/update/action;
- Event time-window list;
- Day Record list with Temporal computed response;
- Wish list/read with Policy;
- Service principal path where applicable.

Record for each scenario:

- request duration P50/P90/P99;
- CPU time;
- D1 round trips/request;
- SQL statement count and rows read;
- cold Registry load versus hot-cache behavior.

Exit: performance evidence is acceptable, full Phase-3 semantic/security staging E2E passes, and HomeMew migration may proceed to Phase 4.

## 7. Explicit non-goals for this convergence

Do not introduce merely for anticipated scale:

- Workers KV Registry cache;
- Cache API Registry layer;
- Durable Object Registry read path;
- Space-sharded Durable Object business storage;
- distributed cache invalidation infrastructure;
- per-model generated TypeScript routers/services.

The expected platform scale is fewer than roughly 25 ordinary business models, low daily mutation volume and only hundreds of business API requests per day. The architecture should remain simple enough to operate and debug directly in D1/Workers while eliminating known structural inefficiencies.

## 8. Migration impact

HomeMew Phase 4/5 work remains blocked until P1-P7 complete.

HomeMew migration tooling must target the final typed model-table/resource-relation/capability schema produced by this convergence. It must not import production data into the intermediate `resource_records.data_json` representation and then migrate it again.
