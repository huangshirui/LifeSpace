# Phase 3 Status — Metadata-driven Platform Runtime

Status: **Complete — metadata runtime, typed storage, staging semantics/security, D1 I/O budgets and representative APAC performance all verified**

Updated: **2026-08-13**

HomeMew production/client cutover has **not** started and LifeSpace production resources have not been touched by the Phase-3 verification work. The Phase-3 blocker on HomeMew migration is now removed; Phase 4 may begin against the pinned final Phase-3 contract.

## Target invariant

> Adding an ordinary LifeSpace business model must not require modifying Core Runtime source code.

The completed runtime is:

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

## Completed architecture state

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

## Final physical-storage and request-I/O convergence

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

Verified guarantees:

- `resource_records.data_json` is removed;
- `resource_index_values` is removed;
- ordinary scalar CRUD/query executes against generated typed model tables;
- model publication can generate bounded deterministic DDL from validated metadata;
- hot-cache model route resolution uses an isolate-memory Runtime Model Descriptor snapshot and performs zero Registry D1 reads;
- list/query response hydration does not perform D1 I/O per returned record;
- mutable authorization remains real-time/current-state checked;
- D1 round-trip budgets are enforced by integration tests: single GET <= 4, list/query <= 5, mutation <= 6, hot Registry = 0;
- Core staging/production Wrangler configuration enables Cloudflare Smart Placement while local development keeps default local placement behavior.

## Proving versions

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

## Staging semantic/security evidence

The typed-storage staging convergence through schema 24 passed repository checks, Core/Identity convergence, authenticated Kernel and service-only Model Admin verification, active immutable Model Contract verification, Task/Wish/Day Record/Event semantics, Creation Draft Queue behavior and cleanup of ephemeral authority.

The D1 verifier confirmed typed-envelope consistency for all four proving models and confirmed that `data_json` and `resource_index_values` no longer exist.

## Representative APAC performance acceptance

Authoritative performance gate:

- Workflow: **APAC performance gate**
- Run: **#5**
- GitHub Actions run ID: `31664559657`
- Branch: `main`
- Commit: `12b823098ed73ed3605b82c67e6d763fb503e46b`
- Date: **2026-08-13**
- Result: **success**
- Probe placement: explicitly targeted near `aws:ap-southeast-1`
- D1 primary observed during cleanup: APAC / SIN

The probe first verified the real `POST /run -> Core` path, then measured request time inside the APAC Worker so GitHub Runner geography was excluded from the timed sample.

Acceptance targets:

- common read P50 <= **220 ms**;
- common read P90 <= **500 ms**;
- stretch P50 <= **180 ms**.

Measured results:

| Scenario | Samples | P50 | P90 | P99 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|
| Task single GET | 15 | **47 ms** | **70 ms** | 91 ms | 38 ms | 91 ms |
| Task list, limit 10 | 15 | **44 ms** | **57 ms** | 58 ms | 38 ms | 58 ms |
| Event time-window list | 15 | **54 ms** | **79 ms** | 93 ms | 50 ms | 93 ms |
| Day Record list + Temporal | 15 | **92 ms** | **111 ms** | 116 ms | 69 ms | 116 ms |
| Wish list + Policy | 15 | **45 ms** | **66 ms** | 72 ms | 37 ms | 72 ms |
| Task PATCH | 8 | **65 ms** | **83 ms** | 83 ms | 55 ms | 83 ms |
| Task Workflow complete/reopen | 8 | **58 ms** | **79 ms** | 79 ms | 51 ms | 79 ms |

All five read scenarios passed the Phase-3 acceptance gate and the P50 stretch target. Task list latency remaining essentially flat versus Task single GET is also consistent with the separately enforced O(1) D1 round-trip/list-hydration invariant.

The earlier GitHub-hosted US-runner benchmark remains diagnostic evidence only and must not be used as the APAC acceptance result.

## HomeMew comparison

HomeMew's measured production baseline on 2026-08-12 was approximately:

- request duration P50 **339 ms**, P90 **780 ms**, P99 **2 s**;
- CPU P50 **12.3 ms**;
- D1 query latency P50 **0.16 ms**;
- roughly **24 D1 queries per Worker invocation**, with repeated actor/person lookup dominating query count.

The measurement populations are not identical, so the APAC controlled benchmark must not be described as a direct 5x/7x production speedup. The valid conclusion is that LifeSpace's metadata-driven + typed-storage architecture has no material platform-abstraction latency regression at the intended scale and is comfortably inside the agreed migration gate.

## Phase 3 exit checklist

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
- [x] Core Smart Placement is deployed/verified for deployed environments;
- [x] representative APAC performance gate passed;
- [x] no production deployment occurred as part of the Phase-3 acceptance work;
- [x] no HomeMew client or production-data cutover occurred.

## Next step

Phase 3 is closed. HomeMew migration may proceed to **Phase 4 — native client/Cloud Function/integration adaptation to the final LifeSpace contract**.

Phase 4 must pin an explicit compatible contract pair rather than consume an unversioned active Registry, adapt HomeMew's WeChat identity/token exchange and data layer to Space/Space Person/model-contract semantics, and prove all frozen HomeMew flows against LifeSpace staging before any production data cutover.
