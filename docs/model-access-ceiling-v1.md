# Model Access Ceiling V1 / 模型访问权限上限

Status: planned implementation, not a deployed capability. Tracking: [#589](https://github.com/huangshirui/LifeSpace/issues/589). Direction approved 2026-11-16; detailed governance choices below are the proposed V1 implementation contract, to be reviewed with implementation. This is an Authority Constraint serving A3 Bounded Authority; North Star remains unchanged.

## 1. Semantics / 语义

The durable relation is Space × Entity × Model. Entity type is independent of operation role. V1 accepts only User entities for configuration and enforcement; Service, Agent and Device eligibility is a separate future release, not an implied capability. Do not introduce a universal Principal entity. Resolve the verified root Principal (not actor, request userId or Person) for represented execution. A direct independent Agent or Service does not inherit User authority or User ceiling; an application must never substitute its service identity for a represented user.

The ceiling is a restriction, not an Authority Source, Grant, Model Definition policy, role or credential scope. Existing Membership/Data Grant positive union is unchanged. For ordinary model operations:

```text
base = max(current membership access, active matching Data Grant access)
bounded = min(base, configured ceiling or inherit)
effective = bounded ∩ credential scope ∩ application model access
            ∩ explicit current delegation chain ∩ model capability/policy
```

The read/write/manage ordering follows the current ModelAccess rank. None rejects every ordinary model operation; absence of a row preserves all existing decisions, including free_busy semantics (not a generic model access rank). Read cannot write, Write cannot manage, higher ceiling never adds permission. Both whole-Space and model Grants are bounded. A revoked/expired grant, disabled entity, closed Space, retired model, disabled binding, scope failure or policy denial cannot be repaired by a ceiling. Native and External model key is the canonical stable model key in the source Space, not registration ID, schemaHash or mct revision. Person Directory and Kernel Space management are not ordinary-model targets in V1. Role/model RBAC, record/field ACL and application UI policy are out of scope.

Existing User JWTs and represented Agent operations recheck current ceiling on the next authorization check; issuing or expanding a Delegation must not grant authority above current root authority. Delegations, cached discovery, and opaque operationRef do not authorize execution. Already authorized in-flight operations and previously disclosed bytes cannot be retroactively recalled; analyze commit-time races using existing current-authority and conditional mutation semantics, do not promise stronger atomicity for Provider writes. Existing file URL TTL is a bounded disclosure window and must be documented/tested.

## 2. Governance / 治理（V1 boundary）

- Owner is trusted and cannot be configured as a restricted target. Require direct verified User, existing spaces:manage scope, active actual Owner/Admin membership for ordinary management API; a standalone manage Grant is not sufficient for ceiling management. Owner may configure others; Admin may configure Editor/Viewer only, not self/peer/Owner. Console has distinct Platform Admin actor proof + route-specific service executor; no implicit business data permission. Both use one service/storage and audited mutation.
- A model ceiling bounds ordinary operations under the target's identity, NOT administrative control-plane powers. A user with Space governance (Admin or independent whole-Space manage Grant) can potentially create other authority; V1 is not a security sandbox for a Space administrator. For privacy use an Editor/Viewer without independent management authority. UI and API must not imply otherwise; explicitly test and document role transitions, invite redemption, manage Grants, removal/rejoin and other authority sources. Do not silently change existing governance for unrestricted Spaces. If a restricted user is later promoted or independently granted governance, the ceiling remains on direct/represented ordinary access; they enter the trusted governance boundary. Proposed follow-up: independently constrain governance if that use case is required.
- Preserve a ceiling after Membership removal, including any surviving User Grant and rejoin. Owner can explicitly clear dormant restrictions via target-specific management; no automatic clearing via leave, invite or role change. Resolve target identity and known model, reject invalid/unsupported model/type for new configuration, preserve dormant rows on model retirement; clearing a dormant row must remain possible. External rebinding the same business model key does not lift a restriction. Audit before/after and actual actor/executor/request; no secrets; use atomic configuration + audit writes and optimistic/conditional checks as appropriate.
- No writable management surface or seeded restrictions in a deployable partial implementation until all relevant runtime paths enforce the ceiling. Additive empty migration is safe; once a real ceiling exists, never roll back to a worker that ignores it.

## 3. Storage and hot path / 存储与热路径

Proposed Core table model_access_ceilings with space_id, entity_type, entity_id, model_key, max_access, created/updated metadata. Unique primary key (space_id, entity_type, entity_id, model_key); V1 DB CHECK permits only user, future migration needed to expand eligibility. Store none/read/write/manage only; DELETE restores inheritance. No data backfill, no per-record ACL, no model metadata cache dependency. A second index with entity_type, entity_id leading supports cross-Space inventory; include space_id, model_key and max_access if useful as covering index; avoid extra redundant indexes. No new cache or service.

Fold one indexed scalar lookup into baseAuthorityStatement for User root only, before existing policy identity projection with matching bind order. Reuse existing base snapshot de-duplication by application/principal/Space/model. For independent non-User roots use a constant NULL, no ceiling-table query. Central rank/intersection helper reused by runtime discovery, including effective access projection; preserve spaceAuthority source attribution (membership/grant), do not claim ceiling is an authority source. Discovery must fetch sparse ceiling rows set-wise within existing DB.batch, not call requireModelAccess per model. Space-specific and cross-space runtime visibility differ from configuration-only global static semantics: keep configuration-time discovery's existing app/scope-only behavior; no Space business data from that surface.

Local SQLite proof-of-shape (100,000 synthetic rows, WITHOUT ROWID composite PK): exact point and Space prefix both SEARCH USING PRIMARY KEY; cross-space query entity_type + entity_id alone SCAN before secondary index and SEARCH USING COVERING INDEX after (entity_type,entity_id,space_id,model_key,max_access). This is local query-plan evidence, not D1 timing or production performance. Add actual D1 integration fixture/EXPLAIN assertions; report authorityD1 statement count, rows read, SQL duration and Worker binding wall time using existing diagnostics.

## 4. Contract and paths / 契约与覆盖

Proposed Kernel management API (canonical /api/v1 prefix): GET /spaces/{spaceId}/members/{userId}/model-access, PUT and DELETE /spaces/{spaceId}/members/{userId}/model-access/{modelKey}. GET returns configured rows and sufficient catalog/current base permission context for manager UI, explicitly distinguish configured ceiling vs effective permission; no arbitrary user data. Dormant records must be manageable by authorized Owner even if membership absent. Validate model and actor server-side, audit configuration. Console companion under /api/v1/platform-admin, separate contract/version/proof. Exact payloads, conflict and errors belong in OpenAPI in the implementation PR. No required new scopes, model contract changes, or Identity contract change; additive Kernel/Platform Admin versions and downstream contract checks. Do not change public resource responses unnecessarily; normal denied data calls use existing forbidden family, runtime detail/operations hide unavailable targets per existing contracts. Configuration static semantics are not confidential business records.

Coverage inventory (verify call sites, not just names):
- base model authority and batched mutations/bulk, CRUD/actions including Native and External; External denied before provider I/O.
- Runtime per-Space discovery, /me aggregate/inventory, model detail, reference labels, relation target lookup/resolution/hydration and semantic relation endpoints; no hidden model/record metadata via runtime.
- OAuth MCP operation discovery and consent preview: preserve independent Agent grant preview semantics, constrain represented User authorization and execution, no stale operationRef bypass; correct Principal/Actor and scope checks.
- Delegation create/expand/re-delegate/execute, Authorization Request and one-use atomic consumption. Independent Actor grants cannot fill root User gap.
- Files upload/finalize/attach/download, history/audit/resource projection, recurrence execution, query/search/aggregation, all compatibility routes.
- Eventing independent subscriber Service authority remains independent; reference-only delivery is not a User data access grant. Review data exported to other principals and distinguish trusted administrators/cross-model copies outside the ceiling boundary.

## 5. Performance / 性能

No extra Worker↔D1 or Identity network round trip; no per-record or per-model remote query; no mutable authorization caching. Preserve all existing docs/runtime-storage-performance.md structural budgets and APAC absolute gates. Native GET ≤2 RTT, query ≤3, create ≤2, relation PATCH ≤4, 20 same-model Batch CREATE ≤2; Registry hot 0. Existing direct Agent 20 same target operations one Authority RTT/one statement; represented opaque Agent two RTT; signed depth-4 chain one RTT. Reuse current instrumentation and tests. Add User inherit/read/none, large sparse permissions, same/mixed-model batch and discovery regression fixtures, negative/no escalation tests, compare identical workload and credential mode.

Fresh baseline: [owner-dispatched APAC diagnostic #43840373649](https://github.com/huangshirui/LifeSpace/actions/runs/43840373649), job 133207242703 succeeded including cleanup. Checkout 92784b74350750f1879405d5f41ba939300dc772; previous deployed release 95c3fb5d4d40a88cf68f9e32a65aedb9c4dfa159 differs only in three production docs. 45 samples per scenario. Historical [#43605536269](https://github.com/huangshirui/LifeSpace/actions/runs/43605536269) retained for context.

| Scenario | P50 ms | P90 ms |
|---|---:|---:|
| User Task GET |49|85|
| User Task List |68|92|
| User Event Window |61|94|
| User Day Record |104|167|
| User Wish List |55|110|
| User Task PATCH |64|93|
| User Task Action |70|94|
| Service Task GET |70|164|
| Service Task List |78|126|
| Service Task CREATE |78|100|
| Service Task PATCH |87|115|
| Service Task Action |87|145|

Previous run differs substantially despite same runtime source. Do not mistake network/environment variation for code changes. Proposed extra guard: matched before/after P50/P90 increase ≤ max(5ms,5%) with repeated controlled samples on comparable fixtures when noisy; retain raw results, compare core phase/SQL and deployed RTT independently; existing absolute release gates and narrow retest policy unchanged. Do not trim or weaken thresholds. Owner dispatches staging/production; no production change before gates pass.

## 6. Implementation sequencing / 实施顺序

1. Draft implementation: additive migration, current-state base evaluator and rank helper, integration tests, contract/permissions changes in same release change. Do not enable configuration yet.
2. Complete all data/authority paths, Discovery, governance/audit and compatibility; negative and positive tests, including restricted direct and delegated user with current Grant, stale token, restore, lifecycle and side channels. No partial production exposure.
3. Account and Console configuration UX; HomeMew/ALOHA/Adapters remain compatible when unconfigured and can optionally improve UI. Do not change application identity.
4. CI typecheck/contracts/build/migrations/security/structural budgets. Exact candidate Staging APAC plus user A/B, denied/allowed, old JWT, Grants, delegation, relation/files/history, external and cleanup. Owner-controlled production only after acceptance. Update production docs after exact successful release. Keep #589 open until acceptance.

### Implementation note — Recurrence transaction boundary

The existing recurrence_generation_guard from migration 0057 independently rechecks membership/Grant/catalog at commit. Schema 80 composes an additional trigger on the same guard table for User Plan/Task ceilings (Owner exemption, none/read deny writes), preserving the original trigger and the same D1 batch. Add denial tests that narrow either target between preflight and commit. The audit table is shared governance evidence, not ordinary record history. No configuration route is enabled yet.
