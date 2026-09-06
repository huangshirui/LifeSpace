# Generic Consumer Readiness v1 — M1 Static Semantic Projection Audit

Status: **M1 acceptance design — no Runtime behavior change**  
Date: **2026-09-07**  
Owning issue: **#165 — Generic Consumer Readiness v1**  
Depends on: M0 matrices, M0-B performance gate, existing #130 and #155

## 1. Purpose

M0 proved that most Generic Runtime execution semantics are already aligned and that the remaining static-side work is bounded. M1 converts the static gaps into implementation-ready acceptance contracts before any M3 behavior or wire-shape changes.

M1 owns five current gaps:

- G1 — authoritative minimum compatibility classification on generic model publication;
- G2 — Temporal stable semantic bindings missing from the generic client projection;
- G3 — query semantics only partially self-described by Runtime Discovery;
- G6 — aggregate Discovery repeats heavy static model semantics under every Space instead of supporting compact/progressive retrieval;
- G7 — normative semantic coverage can currently regress without an independent Conformance-ID / Oracle fixture gate.

M1 deliberately does **not** implement these gaps. The purpose is to make their expected semantics, ownership, performance bounds and tests reviewable first.

## 2. Architecture conclusion: split static semantics from dynamic visibility

The current aggregate Discovery shape conceptually materializes:

```text
Space A
  -> full Task semantics + current access
  -> full Event semantics + current access
Space B
  -> full Task semantics + current access
  -> full Event semantics + current access
...
```

M0-B showed that D1 network trips remain bounded, but payload/serialization grows approximately with the number of `Space × Model` DTOs. The same stable Task semantics are therefore repeated for every Space in which Task is visible.

The target information model must separate two planes:

```text
Static Semantic Plane
  Model semantic identity/detail
  keyed by model key + active version + schema hash
  authority-independent
  cacheable by semantic identity

Dynamic Visibility Plane
  current Space references
  current model visibility/effective access for each Space
  current Agent Delegation effect where applicable
  request-current and never authority proof for later execution
```

This is the principal M1 architectural decision.

The cost target is therefore not merely “smaller JSON”. It is:

> Heavy static semantic material should be represented once per relevant Model identity, while per-Space repetition should be limited to minimal dynamic visibility edges.

A user may legitimately have `O(S × M)` current visibility edges. The architecture cannot remove that real relationship. It must avoid multiplying the **full field/query/action/capability descriptor** by those edges.

## 3. Progressive generic-consumer information flow

The target client flow is:

```text
compact current capability inventory
  -> identify relevant Space / Model / Capability
  -> load static semantic detail for relevant Model identity
  -> optionally load bounded dynamic relation/reference context
  -> execute through normal Runtime
```

The following are distinct products and must remain distinct:

### 3.1 Compact Current Capability Inventory

Purpose:

> What can the current execution context plausibly work with now, at coarse granularity?

It is dynamic/current and should contain only what is needed to choose the next semantic detail to load.

At minimum it needs enough information to identify:

- current reachable Space reference: `spaceId` plus minimum safe human label;
- visible model semantic identity: model `key`, `route`, `version`, `schemaHash`;
- current effective model access levels for that Space;
- coarse capability/action inventory sufficient for capability selection, without repeating detailed field/query schemas;
- a deterministic way to request the matching semantic detail.

The exact REST path/property names remain Candidate representation design until implementation review. M1 fixes the **information requirement**, not a premature wire schema.

### 3.2 Static Model Semantic Detail

Purpose:

> What does this active Model identity mean, independent of which Space currently exposes it?

The detail is keyed by active semantic identity and must be reusable across Spaces that expose the same model identity.

The minimum detail content is specified in section 4.

### 3.3 Full Immutable Model Contract

The existing `mct_*` generated Model Contract remains the exact immutable all-model OpenAPI/JSON Schema artifact for codegen, audit and deterministic tooling.

It must **not** become the mandatory bootstrap for Runtime clients merely because it already contains complete static semantics. Full contract retrieval and progressive Runtime semantic detail serve different consumer lifecycles.

### 3.4 Dynamic Relation / Reference Context

Relation targets and reference labels depend on current Space/current state/current authority. They remain dynamic and are requested only when a local task needs them.

M2 owns the Reference Resolution security/partial-result contract. #155 remains the dependency for ordinary-record canonical reference labels.

## 4. Static Model Semantic Detail acceptance contract

A generic client with no handwritten knowledge of Task/Event/Wish/DayRecord must be able to recover the following stable facts for one selected active model.

### 4.1 Identity and display

Required semantic facts:

- model `key`;
- route;
- active model version;
- schema hash;
- singular/plural display names;
- model description when present;
- declared model access levels.

The static detail's `(key, version, schemaHash)` must agree exactly with the identity advertised by the current dynamic inventory and with the active generated Model Contract manifest.

### 4.2 Field declarations

Every declared field must expose the existing Model Definition semantics relevant to generic clients:

- key;
- type;
- title/description;
- required;
- nullable;
- immutable;
- readOnly / Mutation Authority;
- valid type-specific constraints;
- enum values;
- record relation target model;
- relation target/cardinality semantic metadata.

Current target instances must **not** be encoded in static field semantics.

### 4.3 Defaults

All current server defaults must be available as static semantics.

Clients may use defaults for forms/tool schema generation, but Runtime remains authoritative when applying and validating defaults.

### 4.4 Complete query-input semantics

M0 G3 exists because `query.searchable/filterable/sortable` alone does not completely describe the currently accepted generic query surface.

M1 requires the client projection to make every supported query input discoverable without handwritten URL conventions.

For Generic Query this includes:

- whether `q` is available and its current constraints;
- exact-filter input for each `filterable` field;
- for filterable `date`, `datetime`, `integer`, and `number`, the supported lower/upper range inputs corresponding to current `fieldFrom` / `fieldTo` semantics;
- enum filter's current one-value / comma-separated-set semantics where supported by Runtime/Model Contract;
- generic ordered sort:
  - criterion syntax/semantic field + direction;
  - repeatable ordered tuple;
  - maximum 8 criteria;
  - default `createdAt:desc` when no capability semantic sort overrides it;
  - always-sortable envelope fields `createdAt` and `updatedAt`;
  - nullable null-last behavior;
- cursor and limit semantics needed for deterministic generic pagination.

For current Capability query semantics this includes:

**Calendar**

- `rangeStart` paired with `rangeEnd`;
- `dateStart` paired with `dateEndExclusive`;
- `calendarStart:asc|desc` semantic sort;
- semantic sort is standalone rather than composable with a Generic Query sort tuple.

**Temporal**

- `attentionOnly`;
- `attention:desc`;
- `effectiveDate:asc|desc`;
- semantic sort is standalone rather than composable with a Generic Query sort tuple.

A generic client must not need to know that “a date filter probably has a `FooFrom` parameter” or that “Temporal probably accepts `attentionOnly`”. Those are current platform query semantics and therefore belong in a LifeSpace-owned client projection.

### 4.5 Action descriptors

Static model detail must expose callable Action semantics, not Action implementation internals.

For each Record Action or Capability Action the static descriptor must support:

- key;
- kind (`workflow` / capability-owned semantic action);
- required declared access level;
- caller-owned semantic input field schema;
- optimistic-concurrency requirement as a separate technical input role;
- enough invocation identity to map to the current Runtime operation without model-specific Adapter code.

For current Workflow v1, caller-owned semantic input remains empty. `version` remains concurrency evidence, not a semantic Action field.

For Temporal `record-occurrence`, `occurredOn` and optional `note` remain semantic inputs while record version remains concurrency evidence.

### 4.6 Capability inventory and stable bindings

All registered current capabilities must expose stable semantic role bindings needed by a generic consumer.

Calendar already demonstrates the correct pattern and must retain:

- allDayField;
- timedStartField;
- timedEndField;
- startTimezoneField;
- endTimezoneField;
- allDayStartField;
- allDayEndExclusiveField;
- optional attendeePersonField.

Temporal must add equivalent generic projection of its existing canonical bindings:

- kindField;
- anchorDateField;
- cycleDaysField;
- attentionBeforeDaysField;
- attentionAfterDaysField;
- statusField;
- optional subjectPersonField;
- occurrences capability flag.

These are reusable semantic facts. They are **not** UI instructions.

## 5. Facts that must remain server-internal

Self-describing does not mean exporting the implementation of authority or transitions.

The following are not required in a generic client semantic projection:

- Policy expression ASTs;
- Action Policy ASTs;
- Guard implementation lists;
- Branch conditions;
- `set` assignment maps;
- physical schema/storage plans;
- SQL/query plans;
- Data Grant/Membership tables;
- internal authorization rank calculations.

Reasons:

1. exposing them is unnecessary for correct invocation;
2. clients must not reimplement authorization or predict a transition as authoritative;
3. these internals would create stronger coupling to Candidate representation without increasing semantic correctness;
4. Action/Policy execution remains server-authoritative and current-state dependent.

A currently visible Action therefore means:

> the current coarse authority allows this Action to be considered/invoked.

It does **not** mean its record-specific Policy/Guard/version check will succeed.

## 6. One semantic projection compiler, not parallel conventions

M0 found that Model Contract generation already knows query/operator/action/capability semantics that Runtime Discovery only partially exposes.

M1 requires implementation to avoid two independently maintained mappings such as:

```text
Model Definition -> Model Contract mapper A
Model Definition -> Runtime client projection mapper B
```

when both need the same semantic facts.

Preferred implementation direction:

```text
validated Model Definition / compiled Runtime descriptor
        |
        v
shared semantic projection primitives
        |--------------------|
        v                    v
generated Model Contract   progressive client semantic detail
```

This does not require one giant DTO or one shared wire schema. It requires the semantic mapping rules to have one code-owned derivation path so Calendar/query/relation/Action facts cannot drift independently.

The generated Model Contract remains an immutable output artifact, not an editable semantic source.

## 7. G1 — authoritative compatibility minimum

### 7.1 Current asymmetry

Current AI Proposal publication already proves the intended rule:

- proposal generation runs `diffModelDefinition()`;
- the proposal stores `recommendedCompatibility`;
- if Core recommends `breaking`, publish rejects caller `compatible`.

The generic Model Admin path still accepts a caller-supplied compatibility classification and delegates directly to `publishModelDefinition()`, whose current checks cover first/subsequent `initial` use but do not enforce `diffModelDefinition()` as a minimum classification.

This is an authoritative publication-loop gap because any caller reaching the generic publication function must receive the same protection.

### 7.2 Required rule

For every existing-model publication:

```text
minimum = diffModelDefinition(current, next).recommendedCompatibility

minimum = breaking  + requested = compatible -> reject
minimum = compatible + requested = breaking   -> allow conservative over-classification
minimum = compatible + requested = compatible -> allow, subject to other gates
```

Existing rules remain:

- first publication requires `initial`;
- subsequent publication cannot use `initial`;
- unchanged definition is rejected;
- route collision is rejected;
- physical publication/migration safety remains a separate required gate;
- exact next Model Contract generation remains deterministic.

### 7.3 Authoritative enforcement location

The minimum classification must be enforced by the authoritative generic model publication function, not only by Console or AI Proposal UX.

`publishModelDefinition()` or an equivalent single authoritative publication boundary must independently obtain the currently published model and compute/verify the minimum classification.

Callers may perform an earlier check for better UX, but bypassing that caller-specific check must not bypass the Core gate.

### 7.4 Acceptance evidence

Focused implementation tests must prove at least:

- direct function/generic HTTP publish of an automatically breaking change with `compatible` is rejected;
- the same change with `breaking` proceeds to normal physical/publication gates;
- a compatible change may be conservatively labeled `breaking`;
- initial/subsequent/unchanged rules remain intact;
- AI Proposal behavior remains consistent with the authoritative function rather than becoming a separate compatibility authority.

No new compatibility DSL is required.

## 8. G2/G3/G6 — progressive static projection acceptance

The exact HTTP representation remains Candidate until the focused implementation PR is reviewed, but the resulting design must satisfy all of these properties.

### 8.1 De-duplication

For one response/request sequence that describes `S` Spaces exposing the same `M` active model identities:

- heavy static semantic detail must not be repeated once per Space-model edge;
- static detail should be independently addressable/cacheable by semantic identity;
- per-Space dynamic edges may repeat only minimum current visibility/access facts.

The implementation should make the **semantic materialization cost** approximately `O(M + visibility edges)` rather than `O(S × fullModelDTO)`.

### 8.2 Progressive loading

A generic consumer must be able to:

1. obtain compact current inventory without loading every field/query/action schema;
2. request one relevant model's static semantic detail;
3. execute normal Runtime operations without fetching unrelated model detail;
4. request relation/reference context only when a current task needs it.

### 8.3 Authority separation

Static semantic detail must not depend on a caller's Space authority except for whether the caller is allowed to discover/access that detail through the chosen public projection.

Current execution authority must remain dynamic and must be rechecked at Runtime mutation/query time.

A cached static detail by `(key, version, schemaHash)` is safe as semantic metadata; a cached positive visibility/access edge is never execution authority.

### 8.4 Compatibility / representation maturity

Runtime Discovery/client projection remains Candidate/Public. An additive or breaking wire change can therefore be made deliberately with known-consumer impact/migration evidence, while preserving Stable current-authority semantics.

M1 does not require freezing the first compact/progressive JSON form as Stable.

### 8.5 Consumer-neutral acceptance

Acceptance must use generic client behavior rather than a Task/Event-specific adapter:

- enumerate compact visible model identities;
- choose one model by supplied identity;
- load its detail;
- derive valid create/update/query/action input shape from platform metadata;
- no handwritten Task/Event/Wish/DayRecord field map.

n8n/MCP/ALOHA may later consume the same facts differently, but none becomes the semantic oracle for this projection.

## 9. G7 — normative Conformance-ID / Oracle fixture design

### 9.1 Goal

Current unit/integration tests are valuable but can silently omit a newly introduced normative semantic, and generator/runtime tests can accidentally self-confirm the same mapping bug.

M1 requires an independent coverage mechanism tied to the normative Model Definition specification.

### 9.2 Source-of-truth rule

Stable `Conformance-ID` markers belong in `docs/model-definition-spec.md` at normative semantic rules.

Example conceptually:

```text
Conformance-ID: MDV1-FIELD-READONLY-01
```

The ID identifies a rule already written in normative prose. It does not encode a second DSL or restate the full rule in machine configuration.

### 9.3 Oracle fixture rule

Oracle fixtures must:

- explicitly list one or more known Conformance-IDs they cover;
- contain independent expected inputs/results derived from normative semantics;
- not generate their expected values by calling the same validator/contract/projection/runtime code under test;
- exercise positive and deny/rejection behavior where the semantic has both sides.

### 9.4 Mechanical coverage gate

CI must fail when:

- a normative Conformance-ID has no fixture coverage;
- a fixture names an unknown/orphan Conformance-ID;
- the same ID is malformed/duplicated in the normative source;
- required fixture shape is invalid.

This turns semantic coverage loss into a repository-visible failure when a new DSL semantic is introduced.

### 9.5 Initial coverage families

The initial v1 coverage map must include current semantic families, not merely current four business models:

- field type validation;
- required/nullable;
- immutable;
- readOnly / Mutation Authority;
- string/numeric/enum constraints;
- relation structure;
- defaults;
- searchable/filterable/range/sort semantics;
- access hierarchy;
- lifecycle Runtime invariants;
- Policy operation/reference/operator boundaries;
- Record Action access/input/concurrency;
- Guard/Branch/set semantics;
- Calendar binding + timed/all-day semantics;
- Temporal binding/computed/query/occurrence semantics.

The fixture catalog is a test oracle, not an alternate Model Definition language.

## 10. Performance acceptance inherited from M0-B

M1 must preserve M0-B and Phase-3 boundaries:

- no mandatory Discovery/detail preflight for ordinary Runtime execution;
- no result-count-linear D1 I/O introduced by projection;
- compact inventory/detail design should reduce repeated heavy semantic payload rather than adding serial waterfalls;
- no distributed cache/KV/push-invalidation design before deployed profiling demonstrates need;
- stable semantic caching is separable from mutable authority;
- local test wall time is diagnostic only;
- any final absolute deployed latency claim uses the existing controlled APAC measurement method.

A representative generic-client request shape should be achievable as:

```text
1 compact current inventory
+ 1 selected static model detail when cache miss / identity changes
+ optional bounded dynamic reference lookup/resolution when needed
+ normal Runtime operation
```

The selected static detail may be reused across multiple Spaces and interactions while its semantic identity remains unchanged.

## 11. M1 implementation decomposition

After this M1 acceptance design is reviewed/merged, M3 should still not begin until M2 dynamic acceptance is also complete. When M3 is allowed, static work should be split into focused changes rather than a mega-branch.

Recommended implementation units:

### S1 — Minimum compatibility publication gate

Owns G1 only.

- make generic publication enforce automatic minimum compatibility;
- preserve existing AI/Console ergonomics as projections over the same Core rule;
- no progressive Discovery work in the same PR.

### S2 — Progressive static semantic projection

Owns G2/G3/G6.

- shared semantic projection primitives;
- compact current inventory + loadable static detail representation;
- Temporal binding;
- complete generic/Capability query-input metadata;
- de-duplicate heavy static semantics from Space visibility edges;
- preserve current authority semantics and M0-B budgets.

Representation versioning/Kernel contract changes must be explicit because Runtime Discovery is Candidate/Public.

### S3 — Conformance-ID / Oracle harness

Owns G7 only.

- add normative Conformance-IDs;
- add independent fixtures;
- add CI coverage/orphan gate;
- no production Runtime behavior change required.

## 12. M1 exit criteria

M1 Static Semantic Projection Audit is complete when all of the following are accepted:

- static semantics and dynamic visibility are explicitly separate information planes;
- compact inventory and per-model static-detail responsibilities are unambiguous;
- static detail content covers all current field/default/query/action/capability facts required for generic invocation;
- Temporal bindings and current query operator/Capability semantics have explicit projection requirements;
- server-internal Policy/Guard/Branch/set mechanics are explicitly excluded from client reimplementation;
- generic publication's minimum compatibility rule and authoritative enforcement location are explicit;
- Conformance-ID / independent Oracle fixture mechanics and coverage families are explicit;
- performance acceptance inherits the M0-B bounded-cost constraints;
- implementation can be split into S1/S2/S3 without inventing new semantics during coding.

M1 completion is permission to proceed to M2 dynamic audit, **not** permission to start S1/S2/S3 until M2 also closes the cross-cutting authority/reference acceptance boundaries required by #165.
