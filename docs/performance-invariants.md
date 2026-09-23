# Runtime Performance and Physical Storage Invariants

This document defines the current performance architecture, request-I/O budgets and production release regression gates for LifeSpace Core. It is normative for ordinary-model storage, Registry runtime lookup, query hydration, authorization I/O and other performance-sensitive paths.

## 1. Architecture decisions

### 1.1 Logical model remains metadata-driven

The invariant remains:

> Adding an ordinary LifeSpace model must not require new handwritten Core runtime source code.

Model Definition / Registry remains the logical source of truth. Generic Runtime, Policy, Workflow and Capability semantics remain shared platform code.

### 1.2 Metadata-driven does not mean universal JSON physical storage

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

### 1.3 Model publication owns physical schema planning

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

### 1.4 Registry stays authoritative but leaves the normal request hot path

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

### 1.5 Authorization state is not long-lived metadata cache

Membership, Data Grants, Application × Model Access and revocable credential state remain current-state authorization checks.

Optimization combines/batches those checks to reduce network round trips while preserving immediate revocation semantics.

Principle:

> Cache/compile stable rules; evaluate mutable authority from current state.

### 1.6 Core placement

Deployed Core environments use Cloudflare Smart Placement. This is a topology optimization for the D1-heavy request path and does not change contracts, authorization or data ownership.

Representative acceptance is measured from an APAC probe explicitly targeted near `aws:ap-southeast-1`; uncontrolled GitHub-hosted US-runner measurements are diagnostic only and are not used as the earlier platform absolute latency gate.

## 2. Request-I/O performance budget

The runtime is designed against D1 network round trips, not only number of SQL statements. D1 `batch()` is preferred when several independent/current-state statements can be sent in one database call without weakening semantics.

Enforced engineering budgets for ordinary hot-cache requests:

- single-resource GET: <= 4 D1 round trips;
- ordinary list/query: <= 5 D1 round trips independent of result count;
- ordinary create/update/delete: <= 6 D1 round trips;
- Model Registry lookup on a hot-cache business request: 0 D1 round trips;
- list response mapping: no per-record D1 queries.

Integration tests enforce these budgets. A `for`/`map` over returned records that performs a D1 query remains an N+1 defect unless explicitly bounded and justified.

## 3. Performance acceptance and benchmark evidence

Platform acceptance targets:

- no ordinary endpoint introduces Registry D1 reads on every request;
- list query D1 call count does not grow linearly with returned item count;
- Core CPU remains a minority of request wall time;
- representative common paths remain within the authoritative APAC latency envelope;
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

Historical external-application measurements and the controlled LifeSpace APAC benchmark are different measurement populations, so the result must not be described as a direct production speedup factor. The supported conclusion is that LifeSpace's metadata-driven + typed-storage architecture introduces no material platform-abstraction latency regression at the intended scale and is comfortably inside the migration gate.

## 4. Explicit non-goals

Do not introduce merely for anticipated scale:

- Workers KV Registry cache;
- Cache API Registry layer;
- Durable Object Registry read path;
- Space-sharded Durable Object business storage;
- distributed cache invalidation infrastructure;
- per-model generated TypeScript routers/services.

The expected platform scale remains fewer than roughly 25 ordinary business models, low daily mutation volume and only hundreds of business API requests per day. The architecture should remain simple enough to operate and debug directly in D1/Workers while preserving the completed structural efficiency gains.

## 5. 2026-09-23 production I/O latency follow-up

Issue #270 records a production observation from service-token traffic using opaque `lsp_pat_*` Service API Tokens. Ordinary Runtime requests remained CPU-light, while request wall time was materially higher than the authoritative earlier platform user-JWT benchmark. Core D1 analytics showed sub-millisecond to low-millisecond SQL execution for the dominant statements, so database execution time itself did not explain the observed wall time.

The follow-up keeps the existing correctness boundary unchanged:

- opaque service credentials still require current Identity introspection on every Core request;
- credential, Service Principal, Application, Membership, Data Grant and Application × Model Access revocation remain current-state decisions;
- no positive authorization cache is introduced merely to reduce latency;
- D1 round-trip budgets and no-N+1 rules remain in force.

The measurement strategy is to attribute synchronous wall time before changing architecture. While #270 is open, staging and production temporarily enable bounded structured phase diagnostics for Core authentication/Runtime phases and Identity current-state D1 phases based on the existing deployment `ENVIRONMENT`; `PERFORMANCE_DIAGNOSTICS=1` may opt another environment in and `PERFORMANCE_DIAGNOSTICS=0` is an explicit kill switch. Diagnostic logs contain request IDs, method/path, placement metadata and aggregate phase durations; they do not log credentials, Authorization headers or request bodies. The temporary default-on deployed diagnostics should be removed after #270 converges.

Identity staging and production also enable Cloudflare Smart Placement, matching Core's existing D1-heavy deployment policy. Production deployment verification requires Smart Placement to remain configured for both Core and Identity and records the reported placement-analysis status. A missing/not-yet-analyzed or `INSUFFICIENT_INVOCATIONS` status is observational, while `UNSUPPORTED_APPLICATION` is treated as a failed placement assumption requiring review.

This follow-up is a topology/observability refinement, not a contract, authority or data-model change. Absolute latency claims must still come from controlled representative measurements rather than SQL execution duration or nested Worker `wallTimeMs` alone.


## 6. 2026-09-23 Runtime D1 round-trip convergence

Production phase timing after the Identity Smart Placement rollout showed that opaque Service API Token introspection had fallen to roughly 61 ms P50, while ordinary Core Runtime GET / Query / PATCH requests still spent hundreds of milliseconds in serialized business-data I/O. Code-level attribution showed that the remaining wall time closely tracked Core Worker↔D1 round-trip count rather than SQL execution duration.

The convergence keeps the Authority boundary explicit: current Model/Space/Application access is decided before business resource data is fetched. Optimization must not batch an unauthorized business read together with the authority decision merely to save a network round trip.

For the current hot Runtime paths, the target becomes:

| Runtime path | Previous Core D1 round trips | Converged budget | Main change |
| --- | ---: | ---: | --- |
| Single resource GET | 4 | 2 | authority batch; then one D1 batch for resource envelope/scalars + relations, with audit projection carried in the resource row |
| Canonical Query / translated GET list | 4 | 3 | authority batch; main query with audit projection; one bounded relation hydration trip |
| PATCH with relation validation | 6 | 4 | authority batch; bundled current resource read; one batched relation-target validation trip; one atomic mutation batch |
| CREATE without relation targets | up to 6 | 2 | authority batch; one mutation batch; response audit comes from the authenticated principal rather than a post-write read |

The response contract does not change. `createdBy` / `updatedBy` continue to use immutable name snapshots with the existing active Space Person fallback for legacy data. Mutation responses may reuse audit evidence already known from the authenticated principal and the pre-mutation resource rather than reading the same envelope again.

Relation-target validation also changes from field-by-field awaits to one bounded `DB.batch()` containing the required Person/record target checks. This preserves the same validation semantics while preventing models with multiple relation fields from multiplying Worker↔D1 network round trips.

The D1 round-trip integration gate is tightened to the converged budgets, including an Event PATCH with a real attendee Person relation. These budgets are correctness/performance invariants for the ordinary hot path, not merely benchmarks.

Observability timing keys that Cloudflare treated as secret-like (`auth.*`, `runtime.authorization`) are renamed to neutral timing names. Smart Placement analysis status is read from the Workers service endpoint rather than inferred from script settings; a missing status means not yet analyzed, while `UNSUPPORTED_APPLICATION` remains a failed placement assumption.


## 7. Current APAC release regression gate

The original earlier platform migration acceptance envelope in section 5 remains historical evidence: representative APAC common-read P50 <= 220 ms and P90 <= 500 ms proved that the metadata-driven platform was safe to carry into external application migration.

After the #270/#274 convergence, that envelope is no longer the only production-release regression gate. Controlled APAC evidence for the exact production candidate showed ordinary reads and mutations in roughly the 50-130 ms range, so continuing to use only 220/500 would allow multi-fold regressions to pass unnoticed.

The current production release gate is scenario-specific and deliberately keeps substantial cloud-noise headroom:

| Scenario class | P50 gate | P90 gate |
| --- | ---: | ---: |
| User JWT ordinary read: Task GET/list, Event query, Wish list | <= 150 ms | <= 250 ms |
| User JWT Day Record / Temporal read | <= 220 ms | <= 300 ms |
| User JWT Task mutation/action | <= 160 ms | <= 250 ms |
| Opaque Service API Token Task GET/list | <= 180 ms | <= 250 ms |
| Opaque Service API Token Task create/PATCH/action | <= 220 ms | <= 300 ms |

Read scenarios use 15 timed samples after warmup. Mutation/action scenarios also use 15 timed samples; this avoids making a release-blocking P90 effectively equal to the maximum of only eight observations.

The wall-time gate and the structural D1 gate remain separate:

- APAC P50/P90 gates protect deployed request experience and topology regressions.
- D1 round-trip integration budgets protect the Runtime from reintroducing serialized I/O/N+1 shapes even when a particular network sample happens to be fast.

A production release must satisfy both. The historical 220/500 migration envelope is retained for comparison and must not be silently rewritten as though it had always been the current release SLO.
