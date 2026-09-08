# Phase 3 Performance / Physical Storage Convergence

Status: **Complete**

Updated: 2026-08-13

> Evolution note: LifeSpace #200 removes the former route index; the current isolate snapshot is keyed only by `modelKey`, with no additional Discovery or D1 hot-path lookup.

## 1. Purpose

Phase 3 proved the metadata-driven direction: ordinary business models are described by Model Definitions and executed by a fixed Generic Runtime instead of handwritten per-domain routers/services.

Before HomeMew client or production-data migration resumed, LifeSpace converged that logical architecture onto a runtime and physical-storage design that keeps the flexibility benefit without paying avoidable per-request interpretation or D1 round-trip costs.

This plan was a blocking extension of Phase 3, not a post-cutover optimization project. The blocking exit gate passed on 2026-08-13 and Phase 4 HomeMew migration may now proceed.

## 2. Measured HomeMew baseline

Cloudflare production metrics observed for the previous seven days on 2026-08-12:

- HomeMew Core Worker: about 8k invocations.
- Worker request duration: P50 about 339 ms, P90 about 780 ms, P99 about 2 s.
- Worker CPU time: P50 about 12.3 ms, P90 about 25.62 ms, P99 about 45.3 ms.
- HomeMew D1: about 193k total queries for the same period, about 24 queries per Worker invocation on average.
- D1 query latency: P50 about 0.16 ms.
- D1 database size: about 721 KiB, 20 tables.
- The most frequent query, `SELECT display_name,avatar_key FROM users WHERE id=?`, ran more than 100k times and accounted for more than half of observed D1 query count.

The baseline showed that SQL execution and JavaScript CPU were not the primary latency source. Repeated Worker-to-D1 calls and N+1 entity resolution dominated the avoidable cost.

Therefore LifeSpace performance work prioritized request shape and I/O count before micro-optimizing JavaScript or introducing additional distributed cache products.

## 3. Target architecture decisions

### 3.1 Logical model remains metadata-driven

The invariant remains:

> Adding an ordinary LifeSpace model must not require new handwritten Core runtime source code.

Model Definition / Registry remains the logical source of truth. Generic Runtime, Policy, Workflow and Capability semantics remain shared platform code.

### 3.2 Metadata-driven does not mean universal JSON physical storage

Final storage is:

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

`resource_records` remains a generic record catalog/common envelope so cross-model relations and capability foreign keys have one stable target. Ordinary scalar business values live in generated typed model tables.

No application or AI agent supplies raw DDL. Physical DDL is generated deterministically from a validated Model Definition.

### 3.3 Model publication owns physical schema planning

Publishing a model does not require a GitHub commit, GitHub Action or Worker deployment.

The implemented flow is:

```text
Model Definition draft
  -> validate
  -> compatibility / dependency checks
  -> deterministic Physical Schema Plan
  -> apply bounded generated D1 DDL through Core
  -> activate Registry + Model Contract revision
  -> invalidate local runtime metadata snapshot
```

Initial publication may create `mdl_<model_key>` and declared indexes. Compatible additive changes may add safely representable columns/indexes. Unsupported destructive/breaking physical changes fail publication until an explicit safe physical migration plan is available.

Kernel/Identity schema changes continue to use repository-owned D1 migrations and normal deployment workflow.

### 3.4 Registry stays authoritative but leaves the normal request hot path

D1 Model Registry remains the durable source of truth.

Ordinary business requests use a Worker-isolate runtime snapshot:

```text
D1 Published Registry
  -> load / validate
  -> compile Runtime Model Descriptors
  -> isolate-memory map by model key
  -> Generic Runtime
```

A compiled descriptor precomputes stable model key/version/schema hash, declared access capabilities, field/query/relation plans and policy/workflow/capability references required by runtime dispatch.

Normal cache hits perform no Registry D1 query and no repeated `definition_json` parse/validation. Cache loss is safe because D1 repopulates the snapshot. Publication/retirement invalidates the current isolate snapshot; bounded TTL handles cross-isolate refresh.

Workers KV, Cache API and a Durable Object Registry layer remain intentionally absent because measured evidence does not justify them at the expected scale.

### 3.5 Authorization state is not long-lived metadata cache

Membership, Data Grants, Application × Model Access and revocable credential state remain current-state authorization checks.

Optimization combines/batches those checks to reduce network round trips while preserving immediate revocation semantics.

Principle:

> Cache/compile stable rules; evaluate mutable authority from current state.

### 3.6 Core placement

Deployed Core environments use Cloudflare Smart Placement. This is a topology optimization for the D1-heavy request path and does not change contracts, authorization or data ownership.

Representative acceptance is measured from an APAC probe explicitly targeted near `aws:ap-southeast-1`; uncontrolled GitHub-hosted US-runner measurements are diagnostic only and are not used as the Phase-3 absolute latency gate.

## 4. Request-I/O performance budget

The runtime is designed against D1 network round trips, not only number of SQL statements. D1 `batch()` is preferred when several independent/current-state statements can be sent in one database call without weakening semantics.

Enforced engineering budgets for ordinary hot-cache requests:

- single-resource GET: <= 4 D1 round trips;
- ordinary list/query: <= 5 D1 round trips independent of result count;
- ordinary create/update/delete: <= 6 D1 round trips;
- Model Registry lookup on a hot-cache business request: 0 D1 round trips;
- list response mapping: no per-record D1 queries.

Integration tests enforce these budgets. A `for`/`map` over returned records that performs a D1 query remains an N+1 defect unless explicitly bounded and justified.

## 5. Performance acceptance target and result

Acceptance targets before Phase 4:

- no ordinary endpoint introduces Registry D1 reads on every request;
- list query D1 call count does not grow linearly with returned item count;
- Core CPU remains a minority of request wall time;
- same-semantics LifeSpace request duration does not regress materially against HomeMew;
- representative APAC common-read P50 <= 220 ms, stretch <= 180 ms;
- representative APAC common-read P90 <= 500 ms;
- measured D1 round trips satisfy the budgets above or have an explicit documented exception.

### Authoritative APAC gate

- Workflow: `APAC performance gate`
- Run: #5
- GitHub Actions run ID: `31664559657`
- Commit: `12b823098ed73ed3605b82c67e6d763fb503e46b`
- Date: 2026-08-13
- Probe placement: explicitly targeted near `aws:ap-southeast-1`
- Result: **success**

The probe first proved the real `POST /run -> Core` route, then measured the Core request inside the APAC Worker. GitHub Runner-to-probe transport therefore did not enter the benchmark timing.

Measured results:

| Scenario | Samples | P50 | P90 | P99 |
|---|---:|---:|---:|---:|
| Task single GET | 15 | **47 ms** | **70 ms** | 91 ms |
| Task list, limit 10 | 15 | **44 ms** | **57 ms** | 58 ms |
| Event time-window list | 15 | **54 ms** | **79 ms** | 93 ms |
| Day Record list + Temporal | 15 | **92 ms** | **111 ms** | 116 ms |
| Wish list + Policy | 15 | **45 ms** | **66 ms** | 72 ms |
| Task PATCH | 8 | **65 ms** | **83 ms** | 83 ms |
| Task Workflow complete/reopen | 8 | **58 ms** | **79 ms** | 79 ms |

All common read scenarios pass the 220/500 ms gate and the 180 ms stretch P50 target.

The HomeMew production baseline and the controlled LifeSpace APAC benchmark are different measurement populations, so the result must not be described as a direct production speedup factor. The supported conclusion is that LifeSpace's metadata-driven + typed-storage architecture introduces no material platform-abstraction latency regression at the intended scale and is comfortably inside the migration gate.

## 6. Implementation slices

### P0 — Performance invariants and baseline

Status: **Complete**.

- Repository-visible performance plan and Agent rules.
- HomeMew Cloudflare baseline preserved as comparison evidence.
- Staging benchmark scenarios defined for Task, Event, Day Record and Wish.

### P1 — Isolate runtime Registry snapshot + compiled descriptors

Status: **Complete**.

- Isolate-memory Registry snapshot keyed only by model key.
- Published definitions loaded/validated/compiled together on cold refresh.
- Bounded TTL and publication/retirement invalidation.
- Tests prove hot-cache and invalidation behavior.

Exit evidence: repeated ordinary requests do not reread/reparse/revalidate Registry rows.

### P2 — Remove request-path N+1 and redundant Space context reads

Status: **Complete**.

- Capability response decoration batches shared context.
- Relation hydration is batched for list responses.
- Current-state authorization statements are grouped with D1 `batch()` where semantics permit.
- No result-mapping path performs D1 I/O per returned record.

Exit evidence: list/query D1 round-trip count is O(1) in result count.

### P3 — Typed physical schema compiler

Status: **Complete**.

- Deterministic table/column/index naming and type mapping.
- Scalar-vs-relation physical planning.
- Initial table/index creation and compatible additive changes.
- Unsupported destructive changes rejected deterministically.
- Reproducibility/collision tests included.

Exit evidence: a new ordinary model obtains typed physical storage without handwritten SQL or deployment.

### P4 — Generic Runtime typed-storage cutover

Status: **Complete**.

- Typed-row create/get/update/delete/query implementation.
- Shared `resource_records` envelope and `resource_relations` relation storage retained.
- Ordinary scalar query dependency on `json_extract` / `resource_index_values` removed.
- Optimistic concurrency, soft delete, relation integrity, Policy/Workflow and Capability behavior preserved.

Exit evidence: ordinary models execute through Generic Runtime + typed `mdl_*` storage.

### P5 — Four-model convergence and obsolete generic JSON/index cleanup

Status: **Complete**.

- Task, Wish, Day Record and Event use typed model tables in staging.
- Calendar and Temporal capability projections preserved.
- `resource_index_values` removed.
- `resource_records.data_json` removed.
- Pre-typed unrecoverable staging orphan envelopes were explicitly cleaned before HomeMew cutover.

Exit evidence: all current ordinary models use typed physical tables plus generic relation/capability projections.

### P6 — Authorization round-trip convergence

Status: **Complete**.

- Application × Model Access, Space authorization and actor Space Person resolution collapsed into a bounded current-state batch.
- Immediate revocation semantics retained.
- Mutation paths reuse previously loaded records and avoid unnecessary write read-back.
- D1 round-trip budget tests are enforced in CI.

### P7 — Staging benchmark and Phase 3 closeout

Status: **Complete**.

Verified scenarios include Task single GET/list/update/action, Event time-window list, Day Record Temporal list and Wish Policy list. Full typed-storage Core/Identity/service-auth/model-contract/four-model/Queue staging gates also passed.

The authoritative representative APAC benchmark is recorded in section 5 and `docs/phase3-status.md`.

Exit: **passed — HomeMew migration may proceed to Phase 4.**

## 7. Explicit non-goals retained

Do not introduce merely for anticipated scale:

- Workers KV Registry cache;
- Cache API Registry layer;
- Durable Object Registry read path;
- Space-sharded Durable Object business storage;
- distributed cache invalidation infrastructure;
- per-model generated TypeScript routers/services.

The expected platform scale remains fewer than roughly 25 ordinary business models, low daily mutation volume and only hundreds of business API requests per day. The architecture should remain simple enough to operate and debug directly in D1/Workers while preserving the completed structural efficiency gains.

## 8. Migration impact

The Phase-3 performance blocker is cleared as of 2026-08-13.

HomeMew Phase 4 client/Cloud Function/integration adaptation may begin against the explicit final Phase-3 contract pair. Phase 5 migration tooling must continue to target the final typed model-table/resource-relation/capability schema and must never import production data into the discarded `resource_records.data_json` representation.
