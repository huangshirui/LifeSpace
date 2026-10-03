# Agent-ready Authority and Change

Status: **Active platform authority specification**.

## 中文摘要

LifeSpace 将 **Principal（权利主体）**、**Actor（执行者）**、**Application（应用上下文）** 与 **Delegation（委托）** 分开建模。

核心规则：

- Core 只接受经过验证的 Application / Principal / Actor，不信任客户端自行声明身份；
- `Principal == Actor` 时不需要 Delegation；`Principal != Actor` 时必须提供并验证显式 `delegationId`；
- `delegationId` 只是 opaque selector（不透明选择器），不是 bearer capability，也不需要写入 Agent JWT；
- 一个 Delegation 只包含一个 Scope：一个 target（Space / Model / Record）+ 一个 `maxAccess`；
- Delegation 只能缩小 Principal **当前** Authority，不能扩大。当前 Runtime 已支持显式、严格收窄、同 Application 且有深度上限的 re-delegation / delegation chain，并始终保留 Root Principal；详细约束见 `docs/authority-role-capability-redelegation.md`；
- Application 内部 Main Agent -> Sub Agent 的调度，只要 LifeSpace 边界上的 Actor 没变，就属于应用内部实现，不进入 LifeSpace Delegation；
- single-use Delegation 只在一次**成功执行**后消费；mutation 的业务 Change 与消费状态必须原子提交；
- Batch create/update/delete 是 Generic Runtime 的一等能力，不允许通过循环调用单条 API 或 N 次串行 Authority check 实现；
- 一个 Batch 可产生 N 个业务 Change，但属于一个显式 ChangeSet；Eventing 对同一显式 Batch 聚合 delivery，不对互不相关的独立操作做时间窗口合并。

## Purpose

LifeSpace supports independent applications and Agents without coupling the platform to any particular orchestration product or creating an AI-specific data world.

The stable platform path is:

```text
verified credential
  -> normalized Execution Context
  -> current Effective Authority
  -> normal Model / Capability validation
  -> commit the same Shared Reality
  -> durable Change / ChangeSet attribution
  -> reference-only Eventing evidence
```

## 1. Identity-capable entities and operation roles

Entity identity and operation role are orthogonal.

Identity-capable entities may include User, Agent, Application, Service, Device and future platform entity types. Being identifiable does not imply that an entity automatically owns business authority.

Every governed business operation distinguishes:

- **Principal** — whose Authority is ultimately exercised;
- **Actor** — who/what actually executes the operation at the LifeSpace trust boundary;
- **Application** — the registered application context through which the operation occurs;
- **Delegation** — when Principal and Actor differ, the Principal's explicit permission for that Actor to represent it;
- **Grant / Scope** — the Space/model/record and access boundary.

An application may internally dispatch from a Main Agent to specialist Sub Agents without creating a LifeSpace delegation chain when the logical Actor presented at the LifeSpace trust boundary remains unchanged. Internal orchestration and internal authorization transfer are application responsibilities.

If a Sub Agent instead becomes an independently identified LifeSpace Actor and calls Core as that Actor, it must have its own valid platform Delegation when it uses another Principal's Authority.

The currently released execution profile does not yet execute re-delegation. The accepted target architecture supports explicit bounded re-delegation while preserving the original Root Principal; see `docs/authority-role-capability-redelegation.md` and #302.

Space Person (`per_*`) is business Policy context, not an Authority-bearing identity. A User Principal may resolve to `principal.personId`; a User Actor may independently resolve to `actor.personId`. For represented User -> Agent execution, the expected current profile is `principal.personId=per_*` and `actor.personId=null`. Co-fetching those policy-context values with current Authority state is only a D1 optimization and must not turn Person into Membership/Grant/Delegation authority.

## 2. Verified Execution Context

All ordinary Runtime read/query/create/update/delete/action/batch requests execute under a normalized context:

```text
ExecutionContext
  application
  principal
  actor
  delegationId?   // selector only; required when principal != actor
```

Rules:

1. Application, Principal and Actor come from verified credential/runtime context. Unsigned request fields never establish these identities.
2. A direct request has `principal == actor` and requires no Delegation.
3. A represented request has `principal != actor` and requires a valid Delegation.
4. The calling product chooses whose Authority the operation intends to exercise as Principal. Core validates that choice; Core does not infer a more permissive Principal.
5. `delegationId` is an opaque selector/reference, not a bearer secret. Possessing an ID grants nothing.
6. The Delegation ID does **not** need to be signed into the Agent execution JWT. The signed credential authenticates Application + Principal + Actor; Core then validates the request-supplied selector against those verified identities and current Delegation state.
7. Core must not search for or silently choose a “best matching” Delegation. Represented operations identify the Delegation they intend to exercise.

For current supported delegated Agent execution, Identity signs:

```text
sub            = User Principal
azp            = Application
principal_type = user
actor_type     = agent
actor_id       = agt_*
purpose        = agent_execution
scope          = stable credential scopes
```

The token authenticates execution identity only. Durable Space/model/record Authority remains current-state Core data.

## 3. Effective Authority

For ordinary model access, effective Authority is the intersection of:

```text
verified execution identity
∩ credential scope
∩ Application × Model Access
∩ Principal current Space Membership / Data Grant
∩ Delegation when Principal != Actor
∩ published Model capability
∩ Model / Capability policy
```

Delegation never fills a gap in Principal Authority. Actor-owned Authority also cannot be used to fill a gap when the declared Principal is someone else.

If Membership/Data Grant/Application Access/Delegation is revoked, narrowed or expires, subsequent requests must observe the current state. A still-valid credential cannot preserve revoked business Authority.

Core returns allow/deny. It does not orchestrate authorization UX, find a grantor, create approval requests, or decide whether the caller should prompt the user.

Stable deny reasons for this boundary are:

- `PRINCIPAL_AUTHORITY_INSUFFICIENT`
- `DELEGATION_REQUIRED`
- `DELEGATION_INVALID`
- `DELEGATION_SCOPE_INSUFFICIENT`
- `APPLICATION_ACCESS_INSUFFICIENT`
- `CREDENTIAL_SCOPE_INSUFFICIENT`
- `MODEL_OPERATION_UNSUPPORTED`
- `POLICY_DENIED`

## 4. Delegation

Delegation expresses exactly one fact:

> One Actor may represent one Principal, inside one Application, using no more than one bounded slice of that Principal's current Authority.

Logical shape:

```text
Delegation
  id
  principal
  actor
  application
  sourceSpace
  scope
    target
      type: space | model | record
      id
    maxAccess: free_busy | read | write | manage
  constraints
    maxUses?        // v1 supports single-use through maxUses = 1
    expiresAt?
  consumedAt?
  revokedAt?
```

Rules:

1. One Delegation contains exactly one Scope.
2. A Scope contains exactly one target and one `maxAccess`.
3. A Delegation is bound to one Application and one source Space.
4. It can only narrow the Principal's current effective Authority.
5. `space` scope may authorize matching models/records inside that Space up to `maxAccess`, still intersected with Application/credential/model policy.
6. `model` scope applies to that model collection in the source Space.
7. `record` scope applies only to the known concrete record. Record-level read does not permit list/query/search/enumeration of the model collection.
8. V1 does not add field-level or predicate-level Delegation.
9. Delegation is not a bearer capability and is not transferable.
10. Current released execution remains single-hop. Target architecture supports explicit bounded delegation chains: parent permission is required, the Root Principal is preserved, every child narrows scope/access/expiry/depth, and Core resolves the full chain from one leaf selector. See `docs/authority-role-capability-redelegation.md`.
11. No Session Delegation / AuthorizationSession.
12. No separate Approval Grant. Single-use, time-bounded and long-lived behavior use the same Delegation model.
13. Delegation fields defining Principal/Actor/Application/Scope/constraints are immutable after issuance. Runtime lifecycle changes only through consumption or revocation.
14. Effective status is derived, not stored:
    - `revokedAt != null` -> revoked
    - `consumedAt != null` -> consumed
    - `now >= expiresAt` -> expired
    - otherwise active

### 4.1 Persistence profile

The durable Delegation schema stores generic operation roles (`principal_type/principal_id`, `actor_type/actor_id`, Application and Scope) so future supported identity-role combinations do not require another table-shape migration. V1 public Delegation management intentionally exposes only the credential-backed direct User -> Agent issuance profile; generic storage does not imply that every Principal/Actor combination is currently executable.

### 4.2 Lifecycle

- **single-use** — `maxUses = 1`
- **time-bounded** — repeated use until `expiresAt`
- **long-lived** — no `expiresAt`; valid until revoked or current Principal Authority no longer permits the operation

Single-use means one **successful execution**, not one attempt.

The following do not consume it:

- Authority denial;
- validation failure;
- missing target;
- Policy denial;
- optimistic-concurrency failure;
- business mutation failure.

For mutations, Delegation consumption and the corresponding committed business Change must be atomic. Concurrent attempts using the same single-use Delegation may produce at most one successful execution.

For a single-use read, data must not be returned unless that request wins the conditional consumption. This path may require a deliberate additional current-state D1 round trip; that cost must not be imposed on ordinary reads.

### 4.3 Multiple business actions

One user confirmation may issue multiple independent Delegations.

If one business intent contains two separately authorized actions, such as deleting an Event and creating a Task, each action may use its own single-use Delegation. If the caller requests atomic execution, the resulting Changes belong to one ChangeSet and Delegation consumption must commit atomically with that ChangeSet.

User confirmation is therefore not 1:1 with Delegation.

## 5. Authorization protocol boundary

LifeSpace exposes standard Delegation issue/list/revoke semantics but does not own product authorization-flow orchestration.

The Application/Agent decides:

- when to request authorization;
- how to explain the requested scopes;
- whether one UI confirmation issues one or several Delegations;
- how to recover from deny responses.

A Delegation can only be authorized by its Principal. A Space administrator or another subject may change the Principal's Authority through Membership/Data Grant, but does not create a Delegation “for” that Principal.

Distinction:

```text
Membership / Data Grant
  someone else gives a Principal Authority

Delegation
  the Principal allows an Actor to represent it using Authority the Principal already has
```

## 6. First-class Batch Change

Generic Runtime supports bounded first-class Batch create/update/delete for Agent and non-Agent callers.

Batch is a platform Change primitive, not client-side looping.

Normative shape:

```text
one Batch request
  -> resolve verified ExecutionContext once
  -> resolve all distinct Authority keys in bounded current-state I/O
  -> load/validate required business state in bounded batches
  -> validate every operation
  -> one atomic commit
       N business mutations
       N governed Changes
       K single-use Delegation consumptions as required
       one ChangeSet correlation
  -> one batch Eventing envelope per eligible Webhook Endpoint
```

Rules:

1. V1 Batch contains 1-20 create/update/delete operations.
2. Operations may target different published models within the same source Space.
3. All operations are atomic: either every operation commits or none commits.
4. Batch must not be implemented as N Runtime HTTP calls.
5. Batch must not perform N serialized Authority checks.
6. Base Authority facts are de-duplicated independently from Delegation state. Different record IDs do not force repeated base Membership/Data Grant/Application × Model reads.
7. Selected Delegation snapshots are de-duplicated by Principal + Actor + Application + Space + Delegation ID; record ID is evaluated only when a record-scoped Delegation requires it.
8. Distinct current-state snapshots are sent through bounded D1 batch I/O rather than serialized Worker -> D1 round trips.
9. Every committed resource mutation produces its own `resource_changes` row.
10. All Changes committed by one explicit Batch share one ChangeSet identifier.
11. A single-use Delegation authorizing one business action cannot authorize two successful batch items. Reusing the same single-use Delegation for two items makes the batch invalid/unsuccessful.
12. Independent non-batch operations remain independent; Core must not invent a time-window ChangeSet merely because operations happen close together.
13. Batch Eventing aggregates only the explicit ChangeSet. It does not change individual Change identity/history.

## 7. Governed Change

`resource_changes` is lightweight append-only evidence for committed Generic Runtime mutations. It is not a proposal/workflow engine and does not replace the domain record.

Each Change records at least:

```text
target record / Space / model
operation
version before / after
changed fields / exact field changes
application
principal
actor
delegationId?
changeSetId?
occurredAt
```

Read/query performs Authority Resolution but does not create a Change. V1 does not persist a universal read-access audit.

Principal and Actor attribution is explicit:

- direct action: Principal == Actor, no Delegation;
- represented action: Principal != Actor and Change references the validated Delegation.

Ordinary authorization does not create a generic Proposal/Approval/ChangeAction state machine.

A ChangeSet exists only where an explicit atomic multi-change boundary is needed, including first-class Batch. Ordinary single CRUD does not require a ChangeSet.

## 8. Operation Attribution vs Information Provenance

These are independent concerns.

- **Operation Attribution** — Application / Principal / Actor / Delegation / ChangeSet describe who executed a Change and under whose Authority.
- **Information Provenance** — business-model relations describe what source/business fact a record derives from.

Authority/Delegation/Change must not pre-seed external-source or federation fields.

## 9. Event evidence boundary

Eventing remains reference-oriented.

A single committed mutation produces one Domain Event reference linked to its exact `changeId`.

An explicit Batch produces N individual Domain Event references, one for each committed Change, plus one `changeSetId` correlation. Delivery groups the matching references into one batch callback envelope per eligible Webhook Endpoint.

This preserves both:

- exact per-record Change/Event identity; and
- the user-facing integration expectation that one explicit Batch does not fan out into N callbacks.

Independent operations are never time-window coalesced.

Subscribers requiring full Change attribution follow the opaque `changeId` through normal authorized Change Detail APIs rather than receiving Principal/Actor identity or field values in every callback.

## 10. Performance invariants

Authority complexity must remain bounded by Worker -> D1 round trips, not by conceptual layer count.

Required hot-path invariants:

- direct ordinary Runtime Authority Resolution: at most one Core D1 round trip;
- long-lived/time-bounded delegated Runtime Authority Resolution: at most one Core D1 round trip;
- explicit Delegation uses indexed ID lookup; Core does not scan for a best match;
- Batch Authority Resolution does not scale network round trips with item count;
- identical batch Authority keys resolve once;
- up to 20 operations remain bounded current-state I/O;
- single-use mutation consumption is part of the atomic mutation commit and adds no standalone D1 round trip;
- hot Model Registry lookup remains zero D1 reads;
- mutable Authority state is not protected by a long-lived positive authorization cache.

Structural performance tests are release gates, not advisory benchmarks.

## 11. Supported execution profiles

The conceptual Principal/Actor model is general. V1 implementation does not need to manufacture credential flows for every theoretical entity combination.

Currently supported/required profiles remain grounded in real credential paths:

- User acting directly;
- Service acting under its own Authority;
- Device acting under its own Authority where supported;
- User Principal represented by an application-bound Agent Actor.

Future Agent-as-Principal or other entity combinations may be enabled without changing the role model, but only when an explicit credential + Authority flow exists.

## 12. Acceptance gates

### Positive

- direct user CRUD remains compatible;
- represented Agent operation requires and validates the explicit Delegation selector;
- Delegation revocation/expiry or Principal Authority narrowing immediately blocks subsequent use;
- space/model/record target semantics are enforced;
- single-use mutation consumes only on successful atomic commit;
- concurrent single-use attempts yield at most one success;
- Batch create/update/delete across 1-20 operations is atomic;
- Batch may span published models inside one source Space;
- N Batch mutations produce N Changes sharing one ChangeSet;
- eligible Eventing consumers receive one batch callback envelope rather than N callbacks;
- ordinary and batch paths preserve Model validation, Policy, relation integrity and optimistic concurrency;
- D1 round-trip budgets remain within the repository performance gates.

### Negative

- represented Actor with no selector -> `DELEGATION_REQUIRED`;
- unknown/mismatched/revoked/expired/consumed selector -> `DELEGATION_INVALID`;
- valid Delegation whose target/access is too narrow -> `DELEGATION_SCOPE_INSUFFICIENT`;
- wrong Application cannot reuse a Delegation;
- a record Delegation cannot enumerate a model;
- Agent cannot self-issue broader Authority;
- the same single-use Delegation cannot authorize two successful operations;
- Batch cannot partially commit;
- Application/internal Sub Agent routing cannot bypass the LifeSpace trust-boundary Actor;
- no Agent adapter or Batch path may bypass normal Runtime semantics.
