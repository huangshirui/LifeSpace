# LifeSpace Runtime Storage and Performance

Updated: 2026-09-28

## 中文摘要

LifeSpace 的性能目标不是通过牺牲一致性或授权实时性来换取速度，而是减少不必要的 Worker↔D1 往返、N+1 查询和重复 Registry 解析。

本文件是当前性能与物理存储规范，不记录历史 Phase 状态或具体消费应用的迁移门槛。

## 1. Governing principle

The logical Model Platform remains metadata-driven, while ordinary business data uses deterministic typed persistence and bounded runtime I/O.

The performance invariant is:

> Preserve current-state authority and platform semantics while eliminating avoidable serialized network round trips and repeated metadata interpretation.

## 2. Runtime metadata

D1 Model Registry remains durable authority.

Ordinary hot requests use a Worker-isolate compiled snapshot:

```text
Published Model Registry
  -> load / validate
  -> compile Runtime Model Descriptors
  -> isolate-memory map by modelKey
  -> Generic Runtime
```

A compiled descriptor contains the stable information required for dispatch, validation, field/query planning, relation handling, Policy/Action evaluation and Capability bindings.

Hot-cache ordinary requests must perform zero Model Registry D1 reads.

Publication, supersession and retirement invalidate local metadata snapshots. Cross-isolate freshness is bounded and must never convert stale metadata into authorization proof.

## 3. Typed physical storage

Ordinary scalar business values are stored in deterministic typed model tables:

```text
resource_records
  -> identity / ownership / audit / lifecycle envelope

mdl_<model_key>
  -> typed scalar fields
  -> duplicated immutable space_id for query locality

resource_relations
  -> Person / record relation values

Capability projections
  -> specialized query/correctness structures
```

The Generic Runtime owns persistence behavior. Model publication owns safe physical schema planning.

Do not reintroduce:

- universal mutable JSON business storage;
- per-model handwritten routers/services;
- application-generated raw DDL;
- per-record hydration queries inside list mapping.

## 4. Authority performance boundary

Mutable authority remains current-state data.

The Runtime may compile/cache stable model metadata, but it must not use a long-lived positive authorization cache for:

- Membership;
- Data Grants;
- Application × Model Access;
- revocable Service Principal state;
- Agent Delegation;
- other mutable authorization facts.

Principle:

> Cache stable rules; evaluate mutable authority from current state.

Independent current-state queries should be combined with D1 `batch()` when semantics permit. Policy-only Space Person context may be physically co-fetched with current Authority state, but the returned API keeps it separate from the Authority decision. For the ordinary direct User hot path, Principal and Actor are the same User, so Core performs one User -> Space Person lookup and reuses that result for both policy identities rather than issuing duplicate identical scalar subqueries.

A represented Principal/Actor operation uses an explicit Delegation selector. Delegation lookup is an indexed current-state lookup inside the same Authority round trip; Core must not scan for or choose a best matching Delegation.

First-class Batch mutation resolves the verified Execution Context once. Base Authority facts are de-duplicated by Application + Principal + Space + Model independently from Delegation state; explicit Delegation snapshots are de-duplicated by Principal + Actor + Application + Space + Delegation ID. Record ID participates only in per-operation record-scope evaluation, not in repeated base-Authority reads. Distinct current-state snapshots are prepared together and sent through bounded D1 batch I/O; item count must not become serialized Worker -> D1 authorization round trips or hidden duplicate base-Authority SQL inside one RTT.

Business data must not be fetched before the required authority decision merely to reduce one network hop.

## 5. D1 round-trip budgets

The primary structural performance metric is Worker↔D1 round trips, not raw SQL statement count.

Current hot-path budgets:

| Runtime path | Maximum Core D1 round trips | Required shape |
| --- | ---: | --- |
| Single resource GET | 2 | authority batch, then resource/scalar/relation read batch |
| Canonical Query / translated list | 3 | authority batch, main query, bounded relation hydration |
| CREATE without relation targets | 2 | authority batch, atomic mutation batch |
| PATCH with relation validation | 4 | authority batch, current resource read, batched target validation, atomic mutation |
| Batch CREATE, 1-20 operations, no relation targets | 2 | one de-duplicated authority batch, one atomic ChangeSet mutation batch |
| General Batch mutation, 1-20 operations | O(1) in item count | authority once; bounded grouped record/relation preparation; one atomic ChangeSet mutation batch |
| Non-atomic Bulk mutation, 1-20 operations | O(1) common path in item count | set-wise authority/target/relation preparation; one grouped mutation batch with independent guarded item outcomes |
| Bulk single-use contention slow path | O(N), bounded N<=20 | only after grouped commit is aborted by current single-use Delegation contention; replay survivors independently so unrelated items still commit |
| Single-use mutation | no extra standalone RTT | consume inside the same atomic mutation/Change batch |
| Single-use read | ordinary read budget + at most 1 | conditional successful-use consumption is an explicit slow-path exception |
| Ordinary list mapping | O(1) in result count | no per-record D1 calls |
| Hot Model Registry lookup | 0 | isolate descriptor snapshot |

Tests must fail when these structural budgets regress unless an explicit architecture decision documents a justified exception.

## 6. Query and hydration rules

- Query filtering/sorting uses typed physical columns and declared indexes.
- Relation hydration is batched.
- Person/reference labels must not create N+1 D1 access.
- Capability projections may be joined/batched when required for correctness or performance.
- Reusing already-loaded record/audit evidence is preferred to write-then-read-back when the response can be constructed safely from authoritative values already in the mutation context.
- Relation target checks across multiple fields are batched rather than awaited field by field.

## 7. Mutation rules

Mutation performance optimizations must preserve:

- first-class Batch semantics: Batch is never implemented as a loop over single-operation HTTP/runtime commits;
- Batch update/delete may omit a caller-known version; Core then reuses the current version from the already-required set-wise target load as the expected version for the atomic commit, while an explicitly supplied version remains the caller's optimistic-concurrency expectation;
- omitted Batch version never means blind write: a concurrent change between target load and commit still fails the whole ChangeSet with VERSION_CONFLICT;
- one verified Execution Context per request;
- de-duplicated Authority resolution for equal batch Authority keys;
- model validation;
- current authority;
- optimistic concurrency;
- relation integrity;
- Policy and Action semantics;
- governed Change evidence;
- Principal / Actor / Application / Delegation attribution;
- one Change per committed resource mutation and one ChangeSet correlation for an explicit atomic Batch;
- one `blk_*` correlation for an explicit non-atomic Bulk while every successful item remains its own committed Change and every failed item commits no Change;
- atomic single-use Delegation consumption with the Change it authorizes;
- atomicity of the committed logical mutation.

Performance work must never turn an uncertain write into a blind retry.

## 8. Cloud placement

Core and Identity may use Cloudflare Smart Placement where D1-heavy request paths benefit from placement near their data/services.

Placement is an implementation/topology optimization. It does not alter:

- API contracts;
- authority semantics;
- data ownership;
- revocation guarantees.

Placement-analysis status is operational evidence, not a semantic source.

## 9. Release latency gates

Production candidates use controlled representative APAC probes for user-visible wall-time regression checks.

Current gates:

| Scenario class | P50 gate | P90 gate |
| --- | ---: | ---: |
| User JWT ordinary read: Task GET/list, Event query, Wish list | <= 150 ms | <= 250 ms |
| User JWT Day Record / Temporal read | <= 220 ms | <= 300 ms |
| User JWT Task mutation/action | <= 160 ms | <= 250 ms |
| Opaque Service API Token Task GET/list | <= 180 ms | <= 250 ms |
| Opaque Service API Token Task create/PATCH/action | <= 220 ms | <= 300 ms |

Read scenarios use 15 timed samples after warmup. Mutation/action scenarios also use 15 timed samples.

The wall-time gate and structural D1 gate are independent:

- APAC P50/P90 protects deployed request experience and topology;
- D1 round-trip tests protect runtime request shape.

A production candidate must satisfy both.

## 10. Measurement discipline

Do not infer end-user latency from SQL execution time alone.

When investigating latency, distinguish:

- external client/probe transport;
- Identity authentication/introspection;
- Core authentication;
- current authority evaluation;
- Runtime business-data I/O;
- serialization and outbound transport.

Controlled probes must isolate the measured LifeSpace request segment from unrelated runner-to-probe latency.

Logs may include request IDs, method/path, placement metadata and aggregate phase durations. They must not log credentials, Authorization headers, secret material or request bodies merely for performance diagnosis.

Temporary diagnostics introduced for an investigation must be removed when they are no longer operationally needed.

## 11. Non-goals

Do not introduce the following merely for anticipated scale:

- Workers KV as a Registry authority;
- Cache API as an authorization cache;
- Durable Object Registry read path;
- Space-sharded Durable Object business storage;
- distributed cache invalidation infrastructure;
- per-model generated TypeScript routers/services.

Add infrastructure only when measured evidence demonstrates that the simpler D1/Workers architecture cannot meet the current budgets.

## 12. Review checklist

Any Runtime/storage/performance change must answer:

- Does it preserve current-state revocation?
- Does it preserve the Model Registry as semantic authority?
- Does it keep ordinary models metadata-driven?
- Does it reduce or at least bound D1 network round trips?
- Does result size increase D1 call count?
- Does it introduce per-record hydration?
- Does it change the public response contract?
- Does it affect governed Change/audit attribution?
- Is a new cache storing stable metadata or mutable authority?
- Is the optimization justified by measurement rather than anticipated scale?


## Semantic Relation gates / 语义关系性能门禁

Hot Native Relation paths use isolate registry metadata and set-wise current Authority. Direct User JWT and Service Token Core RTT budgets: create 3, get 3 with hydration, query 3 with hydration (2 without), delete 4; single-use read may add 1. Represented opaque Agent Token adds one bounded chain-resolution RTT and one Identity introspection HTTP call. A 20-action mixed Batch is at most 3 Core RTT with existing endpoints, 2 when all endpoints are request-local creates; represented opaque Agent adds 1. Non-atomic common path uses one grouped commit; only endpoint/single-use commit contention allows bounded <=20 independent replay, preserving per-item atomicity.

Relation tests cover 1060 edges with 1000 hidden before 60 visible, 50+10 complete pages, no hidden continuation and query hydration <=3 RTT / <12000 D1 rows read on this fixture; this rows-read gate is fixture-specific, not an arbitrary-scale SLA. Predicate-free source/target/Space indexes preserve stable sorting; predicate-specific indexes remain. High-connectivity Native delete tests cover 2000 incident edges. Local test duration is not deployed latency; staging JWT/Service/Agent wall-time gates remain required before release. Ordinary paths keep existing budgets and no semantic hydration tax.


## Recurrence gates / 周期计划性能门禁（#338）

No recurrence query is added to ordinary Task completion or to records with no recurring intent. One-Space 20-Plan preparation uses grouped scheduling state, grouped typed hydration, de-duplicated current Authority and one current-root Identity HTTP call; opaque Service/Agent authentication adds one credential introspection. Warm User JWT/Service Token mutation budget <=8 Core D1 RTT; represented opaque Agent <=9. Indexed rolling same-Space batch budget <=8 D1 RTT. Global/Space-local next_materialize_at indexes select due work, and an active-future partial occurrence index plus stable-ID current/history lookup avoid full-plan/history scans. The 1000 parked-Plan test gates <1000 D1 rows read and uses query-plan evidence; its local wall time is not a deployed latency promise. Window 0..90 days and total <=20 materialized Tasks per invocation are internal bounded settings. Cursor/CAS/unique occurrence constraints preserve concurrent retry correctness. Exact-candidate deployed JWT/Service/Agent latency remains a release gate; ordinary Runtime budgets are unchanged.
