# LifeSpace Generic Consumer Contract

Updated: 2026-10-09

## External dynamic contracts / 外部动态契约

Kernel 0.50.0 adds `origin: external` Space-local models beside the unchanged Native shapes. Native entries without `origin` continue to mean Native. External detail/inventory binds `(spaceId,key,schemaHash)`, has dynamic contract metadata and explicit runtime capabilities, and has no Native `version` or immutable mct revision. Unsupported provider fields are absent; normal requests must use the current fields/operator subset. External sorting/null placement/ties are provider-defined rather than Native-guaranteed. Consumers that require Native guarantees must hide External operations they cannot represent. Configuration-time `/me/_discovery/models` remains Native/global; External schema discovery requires the source Space visibility gate. MCP/n8n consumers must intentionally support dynamic contracts before advertising External CRUD; raw API uses the same model-addressed paths.

## 中文摘要

LifeSpace 的消费方可以是传统应用、Agent、工作流、协议适配器或生成式 UI，但它们都只能消费平台已经发布的语义与授权结果，不能成为 LifeSpace Core 的语义来源。

本文件定义长期有效的 Generic Consumer 边界，不记录某个消费应用、适配器仓库或阶段里程碑的完成状态。

## 1. Target properties

A generic LifeSpace consumer should be:

- **self-describing**: discover model and capability semantics without hard-coded domain knowledge;
- **progressively discoverable**: load compact inventory first, then detailed model semantics only when needed;
- **bounded-cost**: avoid mandatory full-world projection and unbounded request waterfalls;
- **authority-preserving**: projection never becomes authorization proof;
- **consumer-neutral**: the same semantic source supports UI, Agent, workflow and protocol adapters.

## 2. Two-plane model

### 2.1 Static Semantic Contract Plane

Owns stable or versioned facts such as:

- model identity and display metadata;
- fields and constraints;
- query/filter/sort semantics;
- Actions and their semantic input;
- Capability bindings;
- immutable Model Contract identity;
- compatibility classification.

Static semantic facts may be cached according to their version identity.

### 2.2 Dynamic Context & Authority Plane

Owns current facts such as:

- visible Spaces;
- effective model access;
- current Membership / Data Grant;
- current Application × Model Access;
- current Agent Delegation;
- current relation/reference targets;
- record lifecycle visibility.

Dynamic projection is a current-state view. It is never a lease of authority.

### 2.3 Configuration-time model semantics

A generic consumer may need model semantics before the current Principal has data Authority in the target Space. Configuration-time model discovery therefore intersects only the authenticated credential scope, current Application × Model Access and the published model's declared access capability. It does **not** require Space Membership, Data Grant or Delegation and returns no Space business data.

This allows a consumer to bind an explicit `spc_*` target and a model such as `event` before execution Authority exists. The binding itself grants nothing. Runtime read/write/action execution still rechecks the complete current Authority intersection and may require a later User Delegation.

Configuration-time model eligibility is current application/credential policy, while the returned model semantics remain versioned static facts. Consumers must not turn either into proof that a concrete Space operation is authorized.

## 3. Ownership boundary

### LifeSpace Core owns

- canonical model semantics;
- current authority evaluation;
- Runtime Discovery;
- configuration-time model semantic discovery;
- relation-target lookup;
- reference resolution/hydration;
- immutable Model Contract publication;
- deterministic compatibility identity;
- bounded current-state projections.

### Protocol / workflow adapters own

- transport conversion;
- tool/schema projection;
- protocol-specific naming;
- retrieval orchestration over LifeSpace APIs;
- token/context optimization that does not invent semantics.

### Product / Agent runtime owns

- conversation state;
- product intent routing;
- multi-system orchestration;
- UX decisions;
- renderer/layout decisions;
- non-LifeSpace tools and capabilities.

Core must not become a product-level intent router merely to make one consumer easier to implement.

## 4. Progressive discovery

A consumer should be able to progress through:

```text
configuration model inventory
  -> selected configuration model semantic detail
  -> explicit Space binding when the product/workflow chooses one
  -> current Runtime Discovery / execution Authority when data access is needed
  -> immutable Model Contract when exact wire/schema identity is required
  -> dynamic relation/reference context when a concrete task needs it
```

A full cross-Space aggregate is allowed as an explicit projection, but it must not become a mandatory first step for every interaction. A consumer that already has a stable `spc_*` target does not need to discover that Space merely to configure a future operation.

## 5. Projection is not authority

Discovery and semantic projection answer questions such as:

- what models the authenticated application/credential may configure;
- what models are currently reachable in a Space;
- what operations are currently visible;
- what fields/actions/capabilities exist;
- what references may currently be resolved.

Execution still rechecks current authorization at the mutation/read boundary.

A stale discovery result must not restore:

- revoked Membership;
- revoked Data Grant;
- narrowed Application × Model Access;
- revoked Delegation;
- disabled Service Principal/application;
- retired/inaccessible model state.

## 6. Relation Target Lookup vs Reference Resolution

These are separate contracts.

### Relation Target Lookup

Used when choosing valid targets for a relation field. It returns bounded candidate context according to current model/field semantics and current authority.

### Reference Resolution

Used when the consumer already has one or more reference IDs and needs authorized human-meaningful projection.

Reference Resolution must:

- accept bounded batches;
- preserve per-item opacity for missing/inaccessible references;
- avoid turning label projection into additional read authority;
- support Person and ordinary-record references according to the source field declaration;
- remain independent of mutation permission.

## 7. Freshness and caching

Safe cache candidates include:

- immutable Model Contract revisions;
- model semantic detail keyed by exact version/schema identity;
- stable presentation metadata.

Dynamic current-state results may be cached only as non-authoritative hints.

Do not authorize from a stale positive cache of mutable authority.

## 8. Compatibility identity

Consumers must distinguish:

- **exact identity**: same immutable contract/schema identity;
- **compatible identity**: a representation accepted under LifeSpace compatibility rules;
- **active runtime state**: what is currently published and reachable.

Environment-local IDs must not accidentally become cross-environment semantic identity.

## 9. Consumer cost rules

Generic consumer support must not force ordinary Runtime calls to pay projection cost they do not need.

Required principles:

- no mandatory full Discovery before every CRUD/query operation;
- no per-record hydration N+1;
- bounded batch reference resolution;
- progressive semantic loading;
- stable metadata reused by exact identity;
- dynamic authority fetched only when needed and never treated as stable metadata.

Runtime/storage budgets remain defined by `docs/runtime-storage-performance.md`.

## 10. Conformance

Platform readiness is validated independently of any one downstream consumer.

Conformance evidence should cover:

- static model/field/query/action/capability projection;
- exact/compatible semantic identity;
- current authority transitions;
- revocation with still-valid credentials;
- relation/reference visibility;
- bounded request shape and payload cost;
- representative generic deterministic and Agent consumers.

A downstream adapter may add its own compatibility tests, but its repository status is not a LifeSpace release gate.

## 11. Non-goals

Core does not own:

- natural-language intent routing;
- consumer-specific tool ranking;
- product conversation memory;
- renderer schema/layout;
- workflow-engine orchestration semantics;
- protocol-specific lifecycle state;
- consumer-specific compatibility pins;
- speculative distributed caching merely for token reduction.

## 12. Governing invariant

> LifeSpace publishes one semantic and authority model. Every consumer is a projection over that model, and no consumer becomes a second semantic source or a prerequisite for the platform's own release lifecycle.


## Semantic Relation consumption / 语义关系消费

Discovery exposes outgoing predicates, meanings, endpoint model constraints and Native-only execution capability. Consumers use generated Relation request/response schemas and the unified Batch; request-local clientRef never becomes persistent identity. Hydration projects canonical reference labels plus requested record views under both endpoint read permissions. Consumers must honor explicit atomic support and must not infer a Provider transaction from a local D1 capability.


## Recurrence consumption / 周期计划消费（#338，开发中）

Consumers discover capabilityBindings.recurrence and structured field valueSchema mechanically in configuration/Space semantic detail or the pinned immutable Model Contract. Binding names are semantic roles, not fixed business fields or UI layout. Task.subject accepts the exposed Person/Record entity_ref schema; generated_from uses the existing Semantic Relation API. Use canonical model CRUD/Task Actions (including skip-occurrence), honor required authority and optimistic versions, and let Core materialize the Tasks. n8n/MCP/Agent/generated UI must not guess plan field names or invent separate scheduler/association syntax.
