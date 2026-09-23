# LifeSpace Runtime Storage and Performance

Updated: 2026-09-23

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

Independent current-state queries should be combined with D1 `batch()` when semantics permit.

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

- model validation;
- current authority;
- optimistic concurrency;
- relation integrity;
- Policy and Action semantics;
- governed Change evidence;
- Principal / Actor / Application / Delegation attribution;
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
