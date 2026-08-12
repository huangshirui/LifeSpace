# Phase 3 Status — Metadata-driven Platform Runtime

Status: **platform/typed-storage implementation complete; authenticated staging v24 passed; performance closeout pending representative APAC validation**

Updated: **2026-08-12**

HomeMew production/client cutover has **not** started and production LifeSpace resources have not been touched.

## Target invariant

> Adding an ordinary LifeSpace business model must not require modifying Core Runtime source code.

The target runtime is now:

```text
Kernel
  Identity-facing Principal boundary
  Space / Membership / Person
  Data Grant
  Model Registry / Model Admin
  Creation Draft orchestration

Metadata-driven Model Platform
  Model Definition / Registry
  isolate-memory Runtime Model Descriptor cache
  Physical Schema Compiler
  Generic Runtime

Physical storage
  resource_records common envelope/catalog
  mdl_<model_key> typed scalar table
  resource_relations shared relation storage
  Capability-owned projections

Generic Engines
  Policy
  Workflow

Capabilities
  Temporal / Cycle
  Calendar
  Registry-driven AI Interpretation
  Async Job / Queue

Model Definitions
  Task
  Wish
  Day Record
  Event
  future ordinary models without Core CRUD source changes
```

## Current architecture state

Ordinary-model authorization remains the intersection of:

```text
verified principal
∩ stable resources:* credential scope
∩ Application × Model Access
∩ current Space membership/Data Grant
∩ published model capability
∩ model policy/Capability restrictions
```

Identity does not mint one token-scope vocabulary per model. Publishing a new ordinary model therefore does not require an Identity runtime change; application access is governed by Core's Application × Model catalog.

Published Model Definitions are validated, immutable by version, schema-hashed and compatibility-classified. Generic Runtime owns schema/default validation, CRUD/query, relation integrity, optimistic concurrency, soft deletion and actor audit. Policy and Workflow use bounded declarative ASTs rather than arbitrary code.

Core contracts remain split into:

```text
Kernel Contract
  apps/core/openapi.yaml
  Core 0.12.0

Model Contract Revision
  mct_<sha256>
  generated OpenAPI + JSON Schema from Registry + Capability contributions
```

Registry-driven Creation Draft derives the writable model set from the published Registry intersected with current Application × Model access, and pins an immutable Model Contract Revision for queued execution.

AI Model Admin remains a guarded proposal control plane only: AI may propose a Model Definition, but Core reparses it through the closed validator, computes deterministic diff/hash evidence, and requires explicit service-admin publication. AI has no arbitrary DDL, SQL, JavaScript, shell, credential or autonomous publish authority.

## Phase 3 performance / physical-storage convergence

The intermediate generic JSON representation has been retired from the supported runtime.

Final ordinary-model physical shape:

```text
resource_records
  common identity / Space ownership / model version
  optimistic version / audit / timestamps / soft delete

mdl_task
mdl_wish
mdl_day_record
mdl_event
mdl_<future_model>
  typed scalar business columns

resource_relations
  person / record relation values

Capability projections
  Temporal / Calendar / future capability storage
```

Current guarantees:

- `resource_records.data_json` is removed;
- `resource_index_values` is removed;
- ordinary scalar CRUD/query executes against generated typed model tables;
- model publication can generate bounded deterministic DDL from validated metadata;
- hot-cache model route resolution uses an isolate-memory Runtime Model Descriptor snapshot and performs zero Registry D1 reads;
- list/query response hydration does not perform D1 I/O per returned record;
- current mutable authorization remains real-time/current-state checked;
- D1 round-trip budgets are enforced by integration tests: single GET <= 4, list/query <= 5, mutation <= 6, hot Registry = 0.

Core staging/production Wrangler configuration now enables Cloudflare Smart Placement. This is a deployment-topology optimization for the D1-heavy Core request path; it does not alter authorization, contracts or data ownership. Local development keeps the default local placement behavior. CI locks this configuration.

## Current proving versions

| Model | Version | Runtime composition |
|---|---:|---|
| Task | 2 | Generic Runtime + Workflow |
| Wish | 3 | Generic Runtime + Policy + Workflow |
| Day Record | 1 | Generic Runtime + Temporal |
| Event | 2 | Generic Runtime + Calendar |

Core Kernel Contract: **0.12.0**  
Core D1 schema: **24**  
Identity Contract: **0.3.0**  
Identity D1 schema: **4**

The Phase-2 handwritten Event/Task/Day Record/Wish services and fixed four-kind Creation Draft implementation are removed from the target Core runtime. Historical migrations remain as audit evidence; destructive staging convergence removed obsolete dedicated-domain and intermediate JSON/index persistence before any HomeMew durable-data cutover.

## Latest authoritative staging evidence

Latest full typed-storage staging convergence before Smart Placement redeployment:

- Workflow: **Deploy staging**
- Run: **#26**
- GitHub Actions run ID: `31607375508`
- Branch: `main`
- Commit: `6620781af236098e78be784c1a59207074025f72`
- Date: **2026-08-12**
- Result: **success**

The run passed:

1. repository `pnpm check`;
2. Core D1 migrations through schema 24;
3. typed model table / common-envelope convergence;
4. removal of `data_json` and `resource_index_values`;
5. removal of unrecoverable pre-typed staging orphan envelopes;
6. Core staging `0.12.0 / schema 24` convergence;
7. Identity `0.3.0 / schema 4` convergence;
8. authenticated Kernel / service-only Model Admin / AI Admin boundary verification;
9. active immutable `mct_*` Model Contract verification;
10. Task CRUD/defaults + complete/reopen Workflow;
11. Event Calendar overlap/query semantics;
12. Day Record Temporal computation / occurrence semantics;
13. Wish Policy + Workflow semantics;
14. Registry-driven Creation Draft Queue reaching a valid terminal state;
15. cleanup of ephemeral staging authority.

The D1 verifier reported typed envelope consistency for all four proving models and confirmed legacy generic storage was removed.

## Performance evidence and remaining gate

HomeMew production baseline measured on 2026-08-12 remains the practical comparison point:

- request duration P50 about **339 ms**, P90 about **780 ms**, P99 about **2 s**;
- CPU P50 about **12.3 ms**;
- D1 query latency P50 about **0.16 ms**;
- roughly **24 D1 queries per Worker invocation** on average, with repeated actor/person lookup dominating query count.

LifeSpace has already reduced the structural D1 hot path to bounded O(1) calls, but the first staging HTTP benchmark was executed by a GitHub-hosted runner in North Central US while staging D1 primary was observed in APAC/Singapore. That run measured roughly 1–5 second HTTP timings and is intentionally classified as **diagnostic only**, because it combines uncontrolled runner geography with long-distance Worker-to-D1 topology and is not comparable to HomeMew's representative APAC workload.

`infra/scripts/verify-staging-performance.mjs` now requires an explicit benchmark profile:

- default `diagnostic-github`: records timings but cannot accept or reject Phase 3;
- `apac`: eligible for the Phase-3 absolute latency gate;
- `ENFORCE_PERFORMANCE_TARGETS=1` is rejected unless the profile is `apac`.

Representative APAC acceptance targets remain:

- common ordinary-resource read P50 <= **220 ms**;
- common read P90 <= **500 ms**;
- stretch P50 <= **180 ms**;
- D1 round-trip budgets must remain satisfied independently of HTTP geography.

## Phase 3 exit checklist

Implemented and verified:

- [x] ordinary models can be added/published without handwritten Core CRUD source;
- [x] published model definitions are immutable/versioned/schema-hashed;
- [x] Generic Runtime enforces schema, relations, authorization, concurrency and soft deletion;
- [x] user/service authorization preserves current credential, Application × Model and Space/Data Grant boundaries;
- [x] generated model contracts are content-addressed and reproducible;
- [x] Task and Wish execute through Model Definition + Generic Engines;
- [x] Day Record executes through Temporal;
- [x] Event executes through Calendar;
- [x] Creation Draft is Registry-driven;
- [x] Phase-2 handwritten ordinary-domain runtime is removed from the target Core;
- [x] typed `mdl_<model_key>` physical storage is active;
- [x] intermediate `data_json` / `resource_index_values` storage is removed;
- [x] Registry hot-path and list N+1 behavior are removed;
- [x] D1 round-trip budgets are enforced by CI;
- [x] Core/Identity/service-auth/model-contract/four-model/Queue staging gates passed on schema 24;
- [x] no production deployment occurred;
- [x] no HomeMew client or production-data cutover occurred;
- [ ] deploy/observe Core staging with Smart Placement enabled;
- [ ] run a representative APAC performance benchmark and meet the Phase-3 latency gate.

## Next step

Deploy the current `main` to staging so the new Smart Placement configuration becomes active. After deployment, allow normal/test traffic to establish placement behavior as needed, then run the same benchmark from a representative APAC execution point using `PERFORMANCE_BENCHMARK_PROFILE=apac` and enforce the documented thresholds.

Phase 3 must not be declared closed and HomeMew migration must remain blocked until that representative APAC performance gate passes.
