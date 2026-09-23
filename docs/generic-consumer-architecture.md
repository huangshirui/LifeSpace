# Generic Consumer Architecture

This document defines the current consumer-facing architecture for LifeSpace clients that do not contain handwritten knowledge of individual ordinary models.

The goal is that a generic consumer can understand and use current LifeSpace semantics through platform-owned metadata and authority projections while keeping request cost bounded and preserving execution-time authorization.

## 1. Required properties

A generic consumer boundary must be:

- **self-describing** — current Model Definition, Action, Capability, query, lifecycle and reference semantics are available without model-specific adapter conventions;
- **progressively discoverable** — consumers obtain compact capability inventory first and load detailed semantics only when needed;
- **bounded-cost** — semantic completeness must not introduce result-count-linear D1 waterfalls, unbounded payloads or mandatory preflight work on ordinary CRUD/query paths;
- **authority-safe** — Discovery, lookup and reference projection are point-in-time context, never authorization proof.

## 2. Static semantics and dynamic authority are separate planes

### Static Semantic Contract Plane

Static facts include:

- model identity, version and schema hash;
- display metadata and field declarations;
- required/default/read-only/immutable semantics;
- query/search/filter/sort semantics;
- Action descriptors, guards, semantic input and concurrency requirements;
- Capability inventory and stable capability field-role bindings;
- canonical reference-label semantics.

These facts originate in Model Definitions / Registry and may be cached by immutable identity.

### Dynamic Context & Authority Plane

Dynamic facts include:

- currently reachable Spaces and models;
- effective access after credential scopes, Application × Model Access, Membership/Data Grant and Delegation intersection;
- current relation targets;
- current reference visibility/resolution;
- mutable principal/service/application status where the credential mode requires current introspection.

Dynamic projections are request-current context. Execution rechecks authoritative state.

## 3. Ownership boundary

### LifeSpace Core owns

- canonical Model / Action / Capability semantics;
- generated Model Contracts and Runtime semantic projections;
- current Effective Authority and revocation correctness;
- Relation Target Lookup and Reference Resolution primitives where platform semantics exist;
- compact capability inventory and progressively loadable semantic detail;
- platform request-shape, batching, pagination and N+1 protection;
- compatibility/publication gates.

### Adapters own

- REST/SDK/protocol/tool transport mapping;
- capability retrieval, ranking or top-K selection from current Core facts;
- protocol-specific virtual/tool projections;
- protocol/tool-count/token budgeting;
- non-authoritative cache/refresh policy;
- UI control/widget/layout mapping.

### Product / Agent Runtime owns

- routing across LifeSpace and non-LifeSpace capabilities;
- conversation/application-specific orchestration;
- product interaction and presentation policy.

Core must not become a natural-language intent router, embedding search service, protocol-specific tool ranker or renderer/layout DSL merely to optimize one consumer.

## 4. Progressive discovery

The normal information flow is:

```text
compact current capability inventory
        ↓
select relevant Space / model / capability
        ↓
load static semantic detail
        ↓
load dynamic relation/reference context only when needed
        ↓
execute through normal Runtime
```

The complete immutable Model Contract remains appropriate for code generation, audit and deterministic tooling. It is not a mandatory per-request bootstrap artifact.

Ordinary Runtime requests must not require a Discovery or reference-hydration preflight when the caller already has the information needed to execute.

## 5. Relation Target Lookup vs Reference Resolution

These are separate contracts:

- **Relation Target Lookup** answers which targets are currently selectable/visible for one source relation field.
- **Reference Resolution** resolves IDs the caller already holds into minimal current display references.

Lookup success is not mutation authorization. Mutation paths re-check current authority, relation validity and model Policy.

Batch resolution is bounded and set-based. Partial resolution uses opaque per-item availability semantics; failure must not reveal whether an unavailable hidden target exists, is deleted or is forbidden.

## 6. Freshness and caching

Safe long-lived cache candidates are immutable or version-addressed static semantics such as Model Contract revisions and schema-hash-bound model detail.

Dynamic authority/context may be cached only as a UX hint. A stale positive cache must never grant execution authority.

No distributed cache/TTL/push-invalidation tier is introduced without measured need. Prefer request-scoped reuse, compiled descriptors, batching and indexed reads.

## 7. Compatibility and evolution

Distinguish:

- exact immutable contract identity;
- semantic compatibility classification;
- the current active Runtime model version.

Historical immutable contract evidence is codegen/audit input, not a promise that every historical model version remains executable forever.

Breaking activation requires explicit migration/versioning strategy. Compatibility classification may be conservatively stricter than the automatic minimum but must not under-classify a proven breaking change.

## 8. Conformance

Generic-consumer conformance must be model-neutral.

Static conformance covers declaration-driven behavior such as required/default/read-only/enum/query/sort/filter/concurrency/Action/Capability semantics.

Dynamic conformance covers state transitions around Membership, Data Grant, Application × Model Access, Delegation, principal/service status where applicable, model publication/retirement and relation-target state.

After an authority mutation commits, an authoritative check performed afterward must observe the new state. The platform does not promise cancellation of a request whose authoritative authorization decision completed before that commit.

## 9. Consumer-cost rule

Discoverable does not mean injected into an LLM or tool context.

Core exposes complete semantics progressively. Consumers choose the smallest projection needed for the task. Deterministic clients and schema-driven UIs can consume the same metadata without any LLM/token cost.

Performance and request-I/O constraints are defined in `docs/performance-invariants.md`.
