# Generic Consumer Readiness v1

Status: **Accepted next-stage architecture and execution plan**  
Date: **2026-09-06**  
Owning issue: **#165 — Generic Consumer Readiness v1**  
Depends on: completed Contract Baseline #106, execution discipline #111, existing follow-ups #130 and #155

## 1. Purpose

LifeSpace has completed its first-stage Contract Baseline: canonical Model Definitions own ordinary-model semantics, Generic Runtime executes those semantics, Stable Authority/Change invariants are explicit, and protocol/application consumers are classified as projections rather than sources of truth.

Hands-on integration through `lifespace-n8n-nodes`, Agent-ready flows, MCP/Adapter design, ALOHA and generated-UI discussion revealed the next maturity problem:

> LifeSpace is already largely **self-executable** — Core can correctly execute a published model — but generic consumers still need a stronger guarantee that the platform is **self-describing**, **progressively discoverable** and **bounded-cost**.

Recent Kernel evolution made this gap visible:

- ordered Generic Query sort and human-facing field `title` metadata;
- source-field-aware Person Relation Target Lookup;
- current authorized Space labels in Runtime Discovery;
- Calendar Capability field-role bindings;
- explicit Action semantic-input vs concurrency metadata separation.

These changes are not evidence that n8n, MCP, Agents or generated UI should own LifeSpace semantics. They are evidence that consumer-facing semantic projection must be treated as a first-class platform concern rather than repaired one consumer finding at a time.

This document defines the next-stage architecture, scope, audit method, performance/cost boundary and acceptance model. It deliberately distinguishes **current implemented behavior** from **planned convergence work**.

## 2. Relationship to existing normative sources

This document does not replace existing sources of truth.

- `docs/north-star.md` owns the durable direction: applications, intelligence and protocols are replaceable; Context is a projection rather than durable reality.
- `docs/architecture.md` owns the current target topology and normative runtime boundaries.
- `docs/permissions.md` owns Effective Authority and current-state authorization semantics.
- `docs/contracts.md` owns contract publication/versioning and Runtime Discovery / Model Contract rules.
- `docs/contract-stability.md` owns Stable/Candidate/Experimental and compatibility policy.
- `docs/model-definition-spec.md` remains the normative human-readable Model Definition / Policy / Action / Capability DSL specification.
- `docs/phase3-performance-convergence-plan.md` preserves the completed typed-runtime and D1 round-trip performance baseline.
- #111 defines durable cross-session execution discipline.

If this document and a current normative source disagree, do not silently reconcile them. Record the discrepancy under #165 or a dedicated implementation issue and resolve the owning source explicitly.

## 3. Target outcome

Generic Consumer Readiness v1 has three equal requirements.

### 3.1 Self-describing

A consumer that has no handwritten knowledge of `task`, `event`, `wish`, `day_record` or another ordinary model can obtain enough platform-owned semantics to correctly understand and invoke the current supported model/runtime surface.

The consumer must not need to guess:

- field labels from machine keys;
- relation labels from conventional field names;
- whether a field is caller-owned or server/semantic-action-owned;
- Action semantic inputs from wire-only concurrency metadata;
- Calendar timed/all-day field roles from model-specific names;
- current Space identity from opaque IDs alone;
- current relation candidates from copied Membership data;
- current effective model/action access from application-side permission tables.

### 3.2 Progressively discoverable

Semantic completeness must not imply that every consumer downloads or expands the full LifeSpace contract before doing local work.

The target shape is:

```text
compact current capability inventory
  -> choose/retrieve relevant model or capability
  -> load detailed semantic projection only when needed
  -> resolve dynamic relation/reference context only when needed
  -> execute through normal Runtime
```

`Discoverable` does **not** mean `injected into every LLM context`.

### 3.3 Bounded-cost

Semantic/context projection must have explicit cost bounds:

- no per-record D1 I/O during list/result mapping;
- no hidden N+1 relation/reference resolution;
- bounded search and cursor pagination for dynamic candidate sets;
- batch resolution where callers already hold many relation IDs;
- stable semantics compiled/cached independently from mutable authority;
- request count/payload/latency measured on consumer-facing projection paths;
- no requirement for Adapter/Agent consumers to carry the complete LifeSpace schema/tool universe into every interaction.

Core owns bounded **platform** cost. Protocol/tool/LLM token economy belongs to Adapters and product runtimes.

## 4. Architecture model

The consumer-facing architecture is deliberately split into static and dynamic planes.

```text
                         Semantic Source
             Model Definition / Policy / Action / Capability
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
       Static Semantic Contract            Dynamic Context & Authority
       ------------------------            ---------------------------
       Runtime Model Descriptor            current Effective Authority
       Model Contract / JSON Schema        Runtime Discovery
       stable field/query metadata         current Space references
       capability semantic roles           Relation Target Lookup
       reference semantics                 Reference Resolution
       compatibility identity              current delegation/grant state
                 |                                 |
                 +----------------+----------------+
                                  |
                                  v
                         Protocol / Adapter Layer
                    REST / SDK / n8n / MCP / Tool
                                  |
                                  v
                       Product / Agent / Experience
                  ALOHA / HomeMew / generated UI / etc.
```

This split is architectural, not merely an implementation optimization.

### 4.1 Static Semantic Contract Plane

Static semantics are determined by the published model/capability set and may be compiled/cached by content/version identity.

Representative facts:

- model key/route/display/description;
- field key/title/description/type;
- required/nullable/readOnly/immutable/constraints/defaults;
- query/search/filter/sort semantics;
- relation target/cardinality structure;
- Action definitions and semantic-input shape;
- Capability inventory and stable field-role bindings;
- Model Contract identity and compatibility evidence.

These facts should not require repeated Registry reads on normal hot paths.

### 4.2 Dynamic Context & Authority Plane

Dynamic projections depend on current state and current execution context.

Representative facts:

- currently reachable Spaces;
- current Space label for an already-authorized reference;
- currently effective model/action access;
- current Agent Delegation;
- current Membership / Data Grant / Application × Model Access effect;
- currently selectable relation targets;
- currently resolvable reference labels.

These are point-in-time projections, not durable authority leases.

## 5. Core / Adapter / Product ownership

This boundary is accepted architecture for v1.

### 5.1 LifeSpace Core owns

Core owns facts that must be consistent across n8n, MCP, Agents, SDKs and generated clients:

- canonical Model / Policy / Action / Capability semantics;
- Model Registry publication and immutable Model Contract generation;
- Generic Runtime validation/default/concurrency/mutation-authority behavior;
- current Effective Authority and revocation correctness;
- Runtime Discovery and safe current Context Projection;
- relation structure and platform-owned target/reference projection semantics;
- compact capability inventory and progressively loadable detail required for generic consumption;
- API/D1/request-shape performance budgets, batching and pagination;
- protection from N+1 behavior in Core projection/runtime paths;
- compatibility/publication gates owned by the platform.

Core answers:

> What exists? What does it mean? What may the current execution context use? What is the authoritative execution behavior?

Core does **not** answer:

> What did this natural-language sentence probably mean? Which three tools should this particular LLM see? How should one protocol rank or render them?

### 5.2 LifeSpace Adapters own

`lifespace-adapters` and protocol-specific adapters own replaceable consumption strategy:

- MCP/OpenAI Tool/SDK/protocol mapping;
- capability retrieval/ranking/top-K selection over Core-provided facts;
- embedding, lexical, rule-based or LLM-assisted retrieval;
- generic vs strongly typed/virtual Tool projection;
- tool-count, schema-size and LLM-token budgeting;
- protocol-specific refresh/caching behavior that never converts cached Discovery into authority proof;
- protocol-specific error mapping;
- presentation-oriented schema shaping that does not invent new domain semantics.

An Adapter may narrow the exposed capability set. It may not mint authority or independently evolve Model/Grant/Action semantics.

### 5.3 Product / Agent Runtime owns

A product runtime such as ALOHA owns conversation/product context that is broader than LifeSpace:

- global routing between LifeSpace and Gmail/Web/Poina/Relay/other capabilities;
- conversation-aware tool selection;
- product confirmation/orchestration policy;
- user interaction and presentation policy.

ALOHA may reuse a LifeSpace capability-retrieval component from `lifespace-adapters`, but LifeSpace Core must not become ALOHA's global intent router.

### 5.4 Experience owns presentation

n8n UI, HomeMew UI, ALOHA UI and generated UI own renderer decisions.

LifeSpace may expose reusable semantic facts that inform presentation, for example canonical `calendar.rangeField` (or legacy split-field roles when inspecting a historical model version). It does not prescribe:

- widget type;
- layout sections;
- field ordering by screen position;
- mobile/desktop layout;
- button placement;
- renderer-specific grouping.

The boundary is therefore:

> **LifeSpace owns reusable semantic facts; Experiences own presentation decisions. Semantic metadata may inform presentation without prescribing it.**

## 6. Generic Consumer Readiness matrices

M0 must materialize four matrices against current `main`. They are audit artifacts, not new semantic sources.

## 6.1 Static Semantic Contract Matrix

For every semantic feature already expressible in current Model Definition v1 / Capability definitions, record at least:

| Column | Meaning |
|---|---|
| Feature | e.g. `readOnly`, default, enum, sortable, Action input, Calendar timed start |
| Canonical source | normative spec / Model Definition / Capability definition |
| Validator | where invalid declarations are rejected |
| Runtime descriptor | whether/how it is precompiled |
| Model Contract | JSON Schema/OpenAPI projection |
| Runtime Discovery/client projection | whether a generic current client can discover it |
| Runtime enforcement | positive + deny behavior |
| Compatibility effect | additive/behavioral/breaking rules |
| Oracle fixture | independent normative expectation coverage |
| Status | aligned / gap / unsupported-by-design |

v1 scope includes current:

- model key/route/display/description;
- all current field types;
- title/description/required/nullable/immutable/readOnly;
- length/numeric/enum/relation constraints;
- defaults;
- searchable/filterable/sortable and range/multi-sort semantics;
- model access levels;
- optimistic concurrency/soft deletion invariants;
- Policy constructs currently defined by the v1 specification;
- Record Actions / guards / branches / set semantics currently defined by v1;
- Calendar Capability semantics;
- Temporal Capability semantics;
- current relation structural semantics.

The matrix must not speculate about future Money/Geospatial/Attachment/etc. capabilities.

## 6.2 Dynamic Context & Authority Matrix

For every current dynamic projection, record at least:

| Column | Meaning |
|---|---|
| Projection | Space/model/action/lookup/reference/etc. |
| Authority inputs | credential scope, App × Model Access, Membership/Grant, Delegation, policy, current state |
| Data source | current-state source of truth |
| Output minimization | minimum safe projection |
| Freshness semantic | point-in-time/current-state expectation |
| Cache safety | what may be cached for UX vs never used as proof |
| Batch/pagination | bounded behavior |
| Deny/partial behavior | fail-closed/opaque semantics |
| Mutation recheck | whether execution revalidates |
| State-transition test | before/after/concurrent evidence |
| Performance evidence | D1/request/payload/latency |

Current v1 dynamic areas include:

- single-Space Runtime Discovery;
- cross-Space `/me/_discovery`;
- current effective model/action access;
- User -> Agent Delegation effect;
- current Membership/Data Grant effect;
- current Application × Model Access effect;
- current principal/service eligibility where relevant;
- Person Relation Target Lookup;
- future record target lookup after #155;
- any batch Reference Resolution introduced by this stage.

## 6.3 Evolution & Compatibility Matrix

Three concepts must remain distinct.

### Exact Identity

```text
mct_<hash>
```

means one exact immutable generated contract artifact in one environment.

### Compatibility

```text
initial | compatible | breaking
```

answers whether existing consumers can continue with an evolution/migration rule.

### Active Runtime

v1 has one currently published/active Model version per model key for ordinary Runtime resolution.

Do not infer:

```text
new mct hash == old consumer must fail
```

or:

```text
old mct exists == old runtime shape remains executable forever
```

The matrix must define for each semantic change:

- expected compatibility classification;
- whether a dynamic consumer should refresh Discovery;
- whether generated SDK/Tool artifacts should regenerate;
- whether a coordinated migration is required;
- physical migration/backfill requirements;
- whether the current single-active-version model can support the transition.

### Single Active Model Version is a v1 decision

Generic Consumer Readiness v1 does **not** introduce simultaneous `Model vN` and `Model vN+1` Runtime serving for different callers.

A breaking change requires an explicit downstream migration/versioning strategy before activation. Prefer a compatible bridge when practical:

```text
old behavior
 -> compatible additive bridge
 -> consumer migration
 -> explicit breaking cleanup when safe
```

If future independent third-party consumers create a demonstrated need for long-lived simultaneous model-version service, treat **Multi-Version Model Runtime** as a separate architecture capability rather than silently embedding it in this program.

## 6.4 Performance / Freshness / Consumer Budget Matrix

For each Core consumer-facing projection record:

- serialized payload size;
- result cardinality bounds;
- D1 round trips;
- whether I/O is O(1) or grows with result count;
- batchability;
- pagination/search contract;
- stable-cache/request-fresh/current-state classification;
- number of Core HTTP requests in representative consumer flows;
- p50/p90/p99 evidence where meaningful;
- whether a full Contract, compact Client Projection or dynamic Context Projection is appropriate;
- whether an Adapter would normally need to expose the information to an LLM/tool context.

The last item is classification guidance only; Core does not own LLM token accounting.

## 7. Performance and cost invariants

## 7.1 Preserve completed Phase-3 runtime budgets

Phase 3 established the current ordinary hot-path discipline:

- hot-cache Registry lookup: 0 D1 round trips;
- single-resource GET: <= 4 D1 round trips;
- ordinary list/query: <= 5 D1 round trips independent of result count;
- create/update/delete: <= 6 D1 round trips;
- list mapping: no per-record D1 queries;
- stable metadata may use isolate snapshots;
- mutable authority remains current-state.

Generic Consumer Readiness must not regress those invariants.

## 7.2 Add projection-path benchmarks

The previous performance gate focused on ordinary CRUD/query. M0/M2 must add representative evidence for consumer-facing projection paths, at minimum:

- `GET /api/v1/me/_discovery`;
- `GET /api/v1/spaces/{spaceId}/_discovery`;
- Person relation target search/page;
- delegated-Agent Discovery;
- batch Reference Resolution if introduced;
- record Relation Target Lookup after #155 if introduced;
- representative payload sizes;
- representative request counts for common generic-client flows.

Do not invent absolute new latency numbers before measurement. Preserve existing APAC targets as comparison context and establish projection-specific gates from measured evidence.

## 7.3 Request waterfalls are part of platform usability

An implementation in which every individual endpoint is fast can still be slow if a generic client must execute a serial waterfall merely to render one ordinary form.

The target flow is conceptually:

```text
open consumer
 -> compact current Discovery
select/retrieve relevant model
 -> static detail from cache/immutable identity where possible
open relation selector
 -> dynamic target lookup only now
submit
 -> one authoritative Runtime mutation
```

Core should not force:

```text
Discovery -> Space detail -> full Model Contract -> candidate dump -> per-record reference lookup -> execute
```

when equivalent bounded projections can avoid the waterfall without weakening boundaries.

## 7.4 No speculative distributed caching

The initial optimization order is:

1. compile/cache stable semantic metadata;
2. reuse calculations inside one request;
3. batch independent current-state D1 statements where semantics permit;
4. use indexed current-state reads;
5. batch reference hydration/resolution;
6. measure;
7. only then evaluate a revocation-safe cross-request cache/revision mechanism if evidence requires it.

Do not introduce short-TTL positive-authority cache, push invalidation, KV, Cache API or Durable Object cache merely because Dynamic Context is current-state.

## 8. Freshness and caching contract

Dynamic Context responses are **point-in-time projections, not authority leases**.

Adapters may cache a Discovery/Lookup response for presentation or interaction efficiency when their protocol/product permits it. They must not treat cached positive state as proof that an operation remains authorized.

Normative consequence:

```text
cached Discovery says Task.write
        !=
current Runtime must allow Task.write
```

Execution remains authoritative and may deny because Membership, Grant, Application × Model Access, Delegation, principal state, model state or Policy has changed.

An Adapter that receives an authority/target stale denial should refresh relevant dynamic context before retrying or re-presenting options.

This is deliberately different from a blanket rule that clients may never cache Discovery.

## 9. Relation Target Lookup vs Reference Resolution

These are separate platform problems and must not be conflated.

## 9.1 Relation Target Lookup

Question answered:

> For this source model/field under current authority, which targets are currently selectable/visible?

Characteristics:

- source-field aware;
- current-authority scoped;
- bounded search/cursor pagination;
- returns minimal references;
- not mutation authority;
- mutation rechecks Policy/relation/current state.

Current Person lookup is the implemented example.

## 9.2 Reference Resolution / Hydration

Question answered:

> The caller already has these relation IDs. What minimal human-readable references may it currently resolve?

This is needed to avoid list/result N+1 behavior such as resolving every assignee separately for hundreds of records.

If introduced, v1 should support batch semantics rather than forcing one request per ID.

### Partial resolution behavior

Preferred v1 semantic:

```text
resolved
unavailable
```

per requested ID.

`unavailable` must be opaque. It must not reveal whether the target is:

- nonexistent;
- deleted/inactive;
- outside current authority;
- hidden by policy;
- otherwise unresolved.

One unavailable item should not necessarily fail an entire batch needed to render an otherwise authorized list.

### Lifecycle information remains an open question

Do not attach `deleted` / `hidden` / `forbidden` reason information to an `unavailable` result merely for UX: that can become an existence side channel.

A future richer lifecycle projection is permissible only where the caller independently has authority to know that lifecycle fact. It is not required for v1.

## 10. Relation/Reference security invariants

Lookup/resolution must remain within the same Stable Authority model as Runtime.

Conceptually, visible relation/reference information cannot exceed the relevant intersection of:

```text
verified execution context
∩ credential scope
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ current Agent Delegation when applicable
∩ source model/field relation semantics
∩ applicable target visibility/reference rules
∩ current target state
```

Exact checks may differ by projection, but no lookup API may become a cheaper route around Runtime authorization.

Hard rule:

> **Lookup success != Write authorization.**

A target returned milliseconds earlier is revalidated during create/update execution under current Policy/relation/current authority.

## 11. Revocation and concurrent-boundary semantics

Current Stable semantics require revoked mutable authority to stop authorizing subsequent requests.

For v1, define the observable boundary precisely:

> Once an authority mutation/revocation transaction has committed, an authoritative authorization check performed after that commit must observe the new state.

v1 does **not** promise to cancel an in-flight operation whose authoritative authorization decision already completed before the revoke commit.

Dynamic conformance must therefore test both:

```text
A allowed
 -> revoke commits
 -> B authorizes afterward
 -> B denied
```

and controlled concurrent cases where the authorization check is intentionally placed on either side of the commit boundary.

Do not use vague words such as `instant` to imply global cancellation/serialization stronger than the implemented transaction/authorization boundary.

## 12. Compatibility automation

Current `diffModelDefinition()` already computes structural changes, `breakingReasons` and `recommendedCompatibility`. Generic Consumer Readiness must audit and close the publication loop so a caller cannot deliberately or accidentally under-classify a change.

Target rule:

```text
automatic minimum = breaking
caller says compatible
 -> reject

automatic minimum = compatible
caller says breaking
 -> allow conservative over-classification

automatic minimum = compatible
caller says compatible
 -> allow, subject to physical/publication checks
```

The automatic classifier should remain conservative for ambiguous consumer risk.

#130 separately owns schema-aware backward compatibility for Stable Public code-owned OpenAPI surfaces. Do not duplicate that logic inside ordinary Model semantics.

## 13. Independent conformance Oracle

Generated Contract and Runtime must not merely confirm the same implementation bug.

The normative Model Definition specification remains the only DSL semantic definition. Add independent **Oracle Fixtures** that encode finite expected behavior examples without becoming another production DSL.

Example categories:

- `readOnly=true` -> generated create/update excludes client assignment; direct Runtime assignment is denied; trusted Action/Capability may write where valid;
- `required=true` without default -> omission denied;
- `required=true` with valid server default -> omission succeeds and server initializes value;
- enum valid vs synthetic invalid value;
- declared vs undeclared sort/filter;
- Action semantic input vs concurrency evidence;
- Capability branch invariants.

Oracle code/fixtures must not derive expected results by calling the same Runtime validator or Contract generator under test.

## 14. Oracle coverage audit

Oracle Fixtures require a mechanical coverage mechanism so new DSL semantics cannot silently enter the normative spec without conformance coverage.

Preferred approach:

- normative semantic sections receive stable `Conformance-ID` identifiers;
- Oracle fixtures declare which IDs they cover;
- CI fails for a normative Conformance-ID without any fixture;
- CI fails for a fixture referencing an unknown/orphan ID;
- duplicate/invalid IDs fail;
- where the DSL syntax surface is machine-enumerable, validator grammar/keys/operators may additionally be checked against the documented conformance inventory.

`Conformance-ID` is a coverage locator only. It must not become a second semantic definition language.

## 15. Static Behavioral Conformance Harness

The Static Harness must be model-agnostic.

It must not contain knowledge such as:

```text
Task.status
Event.startAt
Wish.ownerPersonId
```

except in deliberately named consumer Golden Flow tests outside the generic harness.

The generic harness consumes synthetic conformance models/fixtures and verifies:

```text
normative expectation
      |
      +--> generated Contract projection
      |
      +--> Runtime positive behavior
      |
      +--> Runtime deny behavior
```

This creates the intended triangle:

```text
Normative Specification
        /      \
       /        \
Canonical DSL   Independent Oracle
      |             |
      v             v
Generated Contract  Expected Behavior
       \            /
        \          /
           Runtime
```

The Oracle does not replace Model Definition as source of truth; it verifies the other executable projections against the normative human specification.

## 16. Dynamic State-Transition Conformance Harness

Dynamic Context cannot be verified solely by static contract-derived tests.

The Dynamic Harness uses state transitions:

```text
establish State A
 -> assert projection + execution
 -> mutate authority/state
 -> commit State B
 -> assert projection + execution under the same relevant credential/context
```

Current v1 sources to cover where applicable:

- Membership;
- Data Grant;
- Application × Model Access;
- User -> Agent Delegation;
- Service Principal / application current eligibility on paths that depend on it;
- model publish/retire state;
- relation target active state.

Each scenario should assert both:

1. the Context Projection changes correctly;
2. authoritative execution changes correctly.

Add the concurrent revoke-boundary cases defined in section 11.

Existing Agent-ready staging evidence that a still-valid Agent execution token loses authority after Delegation revocation is reusable evidence/design precedent, not a substitute for the generalized harness.

## 17. Progressive capability discovery

The Core requirement is deliberately modest:

> Expose enough compact, authority-scoped semantic inventory that a consumer can identify relevant available model/capability families and then request/use detailed semantics without requiring the full contract universe up front.

Core does **not** need to know the user's natural-language intent to satisfy this requirement.

Conceptually:

```text
Core compact capability inventory
 -> Adapter/Product selection/retrieval
 -> detailed model/capability projection
 -> optional dynamic relation/reference lookup
 -> Runtime execution
```

The exact HTTP representation remains Candidate until audit/design proves the smallest useful change. Do not create a new endpoint merely because this document uses the term `compact capability inventory`; current Runtime Discovery may already satisfy all or part of the requirement after payload/shape audit.

## 18. Capability Retrieval belongs to Adapters

Capability Retrieval answers:

> Of the capabilities the current authority may use, which are most relevant to this task/conversation/protocol invocation?

That operation may use:

- lexical/rule matching;
- embeddings;
- small-model classification;
- LLM routing;
- conversation context;
- product-specific ranking.

Those are Intelligence/Adapter concerns and are intentionally absent from Core.

A reusable LifeSpace-specific retrieval component may live in `lifespace-adapters`. ALOHA may then compose it inside a broader router that also considers non-LifeSpace capabilities.

## 19. MCP / tool projection implications

MCP is an Adapter, not a Core contract family.

Generic Consumer Readiness does not require one exact MCP architecture. Two useful Adapter strategies remain possible:

### Generic Tool mode

Expose a small stable set such as discover/query/get/create/update/delete/action/resolve, with model/capability semantics fetched progressively.

Advantages:

- bounded tool count;
- broad MCP-host compatibility;
- low static tool-schema overhead.

Trade-off:

- weaker per-model tool typing at the LLM boundary.

### Retrieved / Virtual Tool mode

An Agent runtime or Adapter retrieves relevant current models/capabilities and projects strongly typed tools such as `create_task` only for the local task.

Advantages:

- compact local context;
- stronger tool schemas;
- better tool-selection signal.

Trade-off:

- requires an Agent/host runtime that can manage selective tool exposure/projection.

Neither strategy changes Core semantics. MCP dynamic tool-list mechanisms may optimize a specific host but are not a correctness prerequisite for LifeSpace.

## 20. n8n and schema-driven UI implications

A normal n8n node editor and deterministic schema-driven UI do not inherently consume LLM tokens.

They may use:

```text
Runtime Discovery
 -> model selection
 -> field/client projection
 -> relation target lookup on demand
 -> Runtime execution
```

Common scalar/enum/date/person widgets can be rendered deterministically from semantic metadata. Generated/LLM-enhanced UI is optional intelligence above that base and must not cause Core to absorb renderer metadata.

## 21. Consumer token/cost rule

The platform rule is:

> **Core guarantees semantic correctness + authority correctness + bounded platform cost. Adapters guarantee protocol efficiency + context/tool economy.**

Core therefore should make efficient projection possible, but it does not guarantee final Agent token cost.

A broken Adapter pattern is:

```text
conversation
 + complete Runtime Discovery
 + complete OpenAPI/JSON Schema
 + every model/action tool
 -> LLM on every turn
```

An intended pattern is:

```text
conversation/task
 -> Adapter/Product capability retrieval
 -> authority intersection using Core facts
 -> local relevant semantic/tool subset
 -> LLM only receives what it needs
```

`Discoverable` and `LLM-visible` are different classifications.

## 22. Explicit v1 non-goals

The following are deliberately out of scope, not forgotten gaps.

### 22.1 Field-level conditional authorization

LifeSpace v1 does not add per-Actor dynamic field visibility/write schemas as part of this program.

Record/model/action-level current authorization must be audited. A future concrete requirement for field-level authorization needs a separate semantic design because it affects Contract shape, Discovery, query side channels, actions, caching and Change History.

### 22.2 Multi-Version Model Runtime

LifeSpace v1 does not concurrently serve multiple active semantic versions of one model key to different callers.

### 22.3 Speculative future Capabilities

Do not design this matrix around future Money, Geospatial, Attachment or unknown capability families. New capabilities later join the same conformance/projection framework.

### 22.4 Core-owned intent routing

No embedding index, natural-language model routing, MCP-specific tool ranking or ALOHA conversation router belongs in Core merely to reduce token cost.

### 22.5 Renderer schema

No n8n control type, generated-UI layout section, mobile arrangement or protocol-specific widget metadata becomes Model Definition semantics through this program.

### 22.6 Speculative distributed cache

Do not introduce TTL positive-authority caches, push invalidation, KV or Durable Object cache without measured need and a revocation-safe design.

## 23. Known current inputs and likely gaps

This list is evidence/input, not a declaration that every item requires new implementation.

### Existing platform work already aligned with this plan

- Model Definition v1 normative specification;
- compiled Runtime Model Descriptor snapshot;
- typed-storage D1 performance convergence and no-N+1 list invariant;
- Runtime Discovery current-authority projection;
- server defaults projected into Discovery;
- Action semantic input separated from concurrency metadata;
- field `title` and ordered sort metadata;
- Person Relation Target Lookup;
- current Space label projection;
- Calendar capability field-role bindings;
- Agent Delegation immediate/current-state revocation evidence;
- immutable `mct_*` revisions and Contract Stability classification.

### Existing open issues to reuse

- **#130** — schema-aware Stable Public code-owned OpenAPI compatibility diff gate;
- **#155** — canonical ordinary-record reference-label semantics.

### Current-main audit findings already known from repository inspection

- `diffModelDefinition()` computes `breakingReasons` and a recommended compatibility classification;
- Model publication still needs audit to ensure callers cannot under-classify a change relative to the automatic minimum;
- ordinary Runtime resolution currently uses one `state='published'` model version per model key;
- Phase-3 performance gates do not yet provide equivalent explicit consumer-projection benchmarks for all recent Discovery/Lookup paths.

Do not treat these observations as fixed forever; implementation sessions must recheck current `main`.

## 24. Milestones

## M0 — Current-main inventory and matrix freeze

Objective: establish complete current-v1 coverage without speculative future design.

Deliverables:

- Static Semantic Contract Matrix;
- Dynamic Context & Authority Matrix;
- Evolution & Compatibility Matrix;
- Performance/Freshness/Consumer Budget Matrix;
- complete list of current DSL/Policy/Action/Capability semantics in scope;
- current consumer evidence from n8n, Agent-ready, ALOHA/lifespace-adapters where relevant;
- gap classification: existing issue / new Core issue / Adapter issue / no change required.

Exit:

- every current v1 semantic has one matrix disposition;
- future/unsupported dimensions are explicit rather than implicit blanks;
- no new implementation begins solely from assumption.

## M1 — Static semantic projection and compatibility audit

Objective: prove Specification -> validator -> Contract/Discovery -> Runtime alignment.

Deliverables:

- static matrix findings resolved/classified;
- Oracle fixture model and Conformance-ID coverage design;
- compatibility classifier/publication-gate audit;
- #130 interaction confirmed without duplicated compatibility logic.

## M2 — Dynamic context, authority and cost audit

Objective: prove safe, fresh and bounded dynamic projection.

Deliverables:

- dynamic authority projection map;
- Target Lookup vs Reference Resolution decision/implementation needs;
- revoke/concurrent-boundary tests designed;
- Discovery/Lookup payload/request/D1/latency measurements;
- no-N+1 verification for projection/list hydration paths;
- measured decision on whether any new caching mechanism is justified.

## M3 — Gap closure and conformance implementation

Objective: implement only gaps proven by M0–M2.

Rules:

- one independently reviewable engineering concern per Issue/PR where practical;
- do not use one long-lived mega-branch;
- externally observable semantics update owning spec/contract first;
- security/authority changes require deny-path evidence;
- performance-sensitive paths require request/D1 evidence;
- new architecture decisions append Notion `99 · 架构演进与决策日志`.

## M4 — Generic Consumer acceptance

Objective: prove the platform boundary rather than one product release.

Representative categories:

- generic deterministic contract/discovery consumer with no model-specific schema copy;
- delegated Agent using current authority;
- n8n evidence;
- MCP/API Tool Adapter evidence where available;
- schema/generated-UI evidence where available.

Acceptance must prove both correctness and bounded consumption:

- no missing platform semantic fact forces model-specific guessing;
- local work does not require full-contract download/injection by design;
- dynamic authority is not preserved from stale cached positive context;
- representative projection/request/payload performance is bounded.

## 25. Exit criteria

Generic Consumer Readiness v1 is complete when all of the following are true:

1. every current Model Definition v1 / current Capability semantic in scope appears in the Static Matrix;
2. every current consumer-facing dynamic authority/context projection appears in the Dynamic Matrix;
3. Exact Identity / Compatibility / Active Runtime evolution is documented and mechanically enforced where applicable;
4. no known Specification / Contract / Discovery / Runtime semantic drift remains;
5. no current generic consumer must guess cross-consumer semantic facts such as labels, relation structure, Action semantic input or Capability roles;
6. dynamic lookup/resolution cannot leak authority-protected existence information or become mutation authority;
7. dynamic revocation/state-transition tests cover projection and execution, including the defined concurrent commit boundary;
8. list/projection behavior contains no result-count-linear D1 I/O;
9. Discovery/Lookup/Resolution paths have explicit payload/request/D1/latency evidence and bounded pagination/batching where needed;
10. compatibility under-classification is mechanically prevented for Model publication and #130 covers its separate Stable Public OpenAPI concern;
11. normative DSL conformance coverage cannot silently drop when a new semantic feature is added;
12. Static and Dynamic conformance harnesses include positive and deny/state-transition evidence;
13. field-level conditional authorization remains explicit out-of-scope;
14. multi-version Runtime remains explicit out-of-scope;
15. Core/Adapter/Product ownership is unambiguous;
16. a fresh session can reconstruct the remaining work from repository/Issue/Notion state with no prior chat history.

## 26. Cross-session execution protocol

Use #111's durable-state principle:

> Sessions are disposable executors; repository/GitHub/Notion state is durable state.

For this next stage, bootstrap in this order:

```text
AGENTS.md + nearest nested AGENTS.md
 -> #165
 -> this document
 -> owning implementation Issue / linked PR
 -> current main implementation/tests
 -> relevant normative docs / Notion decisions
 -> affected consumer evidence
 -> implementation
```

Before ending a meaningful implementation session, leave the owning Issue/PR handoff:

```text
Completed
Verified
Remaining
New findings
Next recommended step
```

New findings must be classified before scope expansion:

- **Generic Consumer Readiness blocker** — violates current-v1 semantic/authority/cost exit criteria;
- **Candidate platform follow-up** — useful completeness/extensibility but not required for v1 exit;
- **Adapter/Product issue** — protocol, routing, token economy, orchestration, UX/presentation without a missing Core semantic fact.

## 27. Governing summary

The next-stage boundary can be reduced to four statements:

1. **LifeSpace Core remains the sole owner of reusable domain semantics, current authority and authoritative Runtime behavior.**
2. **Core must expose those facts completely enough, progressively enough and cheaply enough for generic consumers to avoid model-specific guessing and platform-induced N+1/waterfall behavior.**
3. **Adapters own capability retrieval, protocol/tool projection and token/context economy; products own conversation-aware global routing and experience policy.**
4. **Readiness is proved by matrices + independent conformance + dynamic state-transition + measured cost, not by waiting for n8n/MCP/ALOHA to discover the next missing field one at a time.**
