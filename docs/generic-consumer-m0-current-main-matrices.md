# Generic Consumer Readiness v1 — M0 Current-Main Matrices

Status: **M0 inventory/audit evidence — no Runtime behavior change**  
Date: **2026-09-07**  
Owning issue: **#165 — Generic Consumer Readiness v1**  
Performance gate: `docs/generic-consumer-performance-feasibility.md`

## 1. Purpose and audit rule

This document materializes the four M0 matrices required by #165 against the current `main` baseline after the M0-B Performance Feasibility Gate.

It is an **audit artifact, not a new semantic source**. Normative semantics remain in the existing specification/contract/authority sources. If this matrix disagrees with a normative source, the disagreement is a defect to resolve rather than a reason to silently treat this file as authoritative.

Status vocabulary:

- **aligned** — current normative source, validator/contract/client projection/runtime behavior and available evidence are consistent for the audited concern;
- **gap** — a current v1 semantic/consumer requirement is not mechanically complete across the required chain;
- **unsupported-by-design** — the capability is explicitly outside current v1 semantics or intentionally remains server-internal rather than a client contract.

M0 does not fix gaps. It identifies the smallest root concern and links an existing issue when one already owns it.

## 2. Current source map

| Concern | Current source/evidence |
|---|---|
| Model Definition v1 | `docs/model-definition-spec.md`, `apps/core/src/model-definition.ts` |
| Policy v1 | `docs/model-definition-spec.md`, `apps/core/src/policy-definition.ts`, `apps/core/src/policy.ts` |
| Record Action v1 | `docs/model-definition-spec.md`, `apps/core/src/workflow-definition.ts`, Runtime action execution/tests |
| Capabilities | `apps/core/src/capability-definition.ts`, Calendar/Temporal runtime modules, Model Contract generation |
| Runtime descriptor/cache | `apps/core/src/model-registry.ts` |
| Generated Model Contract | `apps/core/src/model-contract.ts`, Model Contract store/service/tests |
| Runtime Discovery | `apps/core/src/runtime-discovery.ts`, Kernel OpenAPI/tests |
| Relation Target Lookup | `apps/core/src/relation-targets.ts`, relation lookup tests |
| Effective model authority | `apps/core/src/model-authorization.ts`, `authorization.ts`, Discovery authority calculation/tests |
| Compatibility classification | `apps/core/src/model-proposal.ts`, Model Admin / AI Proposal publication paths |
| Performance | `docs/performance-invariants.md`, `docs/generic-consumer-performance-feasibility.md` |

## 3. Matrix A — Static Semantic Contract

### 3.1 Model and field semantics

| Feature | Canonical source | Validator / runtime descriptor | Generated Model Contract | Runtime Discovery / client projection | Runtime enforcement | Compatibility / conformance | Status |
|---|---|---|---|---|---|---|---|
| Model key / route | Model Definition v1 | validated; Runtime Registry indexes key + route | manifest pins key/route/version/schemaHash; concrete OpenAPI routes generated | key + route projected | route dispatch resolves active descriptor | key/route changes classified breaking; Registry prevents route collision | aligned |
| Model display singular/plural | Model Definition v1 | validated | plural is used as generated OpenAPI tag; not a standalone complete display projection | full `display` projected | presentation-only semantic; not mutation behavior | current diff records changes; not used as authority | aligned |
| Model description | Model Definition v1 | validated | not required as execution contract metadata | projected as current description/null | no Runtime behavioral effect | descriptive change is not treated as behavioral authority | aligned |
| Field type vocabulary | Model Definition v1 | exactly 13 current types: string, text, integer, number, boolean, date, datetime, timezone, enum, person, person_list, record, record_list | mapped deterministically to JSON Schema/OpenAPI | raw field type projected | Generic Runtime validation/storage/query uses declared type | field behavior/type change is breaking | aligned |
| Field title / description | Model Definition v1 | bounded validation | JSON Schema `title` / `description` | projected | no authorization effect | description is non-behavioral; title is currently conservatively included in field behavior diff | aligned |
| required / nullable | Model Definition v1 | contradictory required+nullable rejected | create/resource required sets + nullable schema | projected | create/update validation | changing existing field behavior is breaking; new required field without default is breaking | aligned |
| immutable | Model Definition v1 | validated | field is omitted from generated update schema | projected | PATCH rejects/does not expose immutable write path | changing field behavior is breaking | aligned |
| readOnly / Mutation Authority | Model Definition v1 + Mutation Authority decision | validated | readOnly retained on resource schema and omitted from create/update writable schemas | projected | ordinary CRUD cannot mutate; authoritative Action may own transition | changing field behavior is breaking | aligned |
| string/text length | Model Definition v1 | type-scoped min/max validation | minLength/maxLength | projected | Runtime validation/default validation | existing constraint change classified breaking | aligned |
| integer/number range | Model Definition v1 | finite/type-scoped min/max validation | minimum/maximum | projected | Runtime validation/default validation | existing constraint change classified breaking | aligned |
| enum values | Model Definition v1 | non-empty, unique, bounded enum validation | JSON Schema enum | projected | Runtime validation/default/Policy/Action literal validation | existing enum behavior change classified breaking | aligned |
| timezone | Model Definition v1 | IANA timezone validation | string + `x-lifespace-format=iana-timezone` | projected type | Runtime validates timezone | type/behavior change breaking | aligned |
| person/person_list relation structure | Model Definition v1 | relation type is intrinsic; list uniqueness enforced in contract/runtime | `x-lifespace-relation` target person + cardinality | relation metadata plus supported lookup contract | Runtime relation integrity + current authority | behavior change breaking | aligned |
| record/record_list relation structure | Model Definition v1 | targetModel required and validated structurally | `x-lifespace-relation` + target model/cardinality | relation projected but lookup explicitly `supported:false` | Runtime relation integrity | record reference-label semantic is separately unresolved under #155 | aligned for structure; lookup gap tracked by #155 |
| defaults | Model Definition v1 | typed/default constraints validated; relation scalar defaults prohibited except empty relation lists | create schema carries default | `defaults` projected | create path applies server defaults | changing existing default breaking; required new field with valid default may remain compatible | aligned |

### 3.2 Query, access and lifecycle

| Feature | Canonical source | Contract projection | Discovery projection | Runtime enforcement | Compatibility / evidence | Status |
|---|---|---|---|---|---|---|
| searchable | Model Definition v1 | generated `q` only when declared | field-key inventory projected | Generic Query restricts allowed search | removing existing capability breaking | aligned |
| filterable | Model Definition v1 | generated exact filter params; date/datetime/integer/number also generate `From`/`To` | only the base filterable field inventory is projected | Generic Query restricts allowed keys/operators | removing capability breaking | **gap — Discovery does not self-describe range parameter/operator shape** |
| generic sortable | Model Definition v1 + Generic Query contract | generated repeatable ordered `sort=field:direction`, max 8 | ordered/repeatable/max/default/envelope metadata projected | ordered multi-sort + cursor semantics enforced | removing existing sortable capability breaking | aligned |
| Capability semantic query/sort values | Calendar/Temporal Capability semantics | Model Contract contributes Calendar range/date parameters and Calendar/Temporal semantic sort/filter values | current Discovery exposes capability names and generic sort metadata, but not the Capability-specific query parameter/sort inventory | Capability query runtime enforces current semantics | covered by capability tests/contract generation | **gap — Model Contract and Runtime know semantics that Discovery client projection does not enumerate** |
| model access declaration | Model Definition v1 | operations generated for model surface; not itself an authority lease | current effective `access` intersection projected | execution re-runs scope/App×Model/Space/Grant/Delegation/model checks | access removal breaking; additive levels compatible when hierarchy valid | aligned |
| optimistic concurrency | Model Definition v1 Runtime invariant | update/delete/action schemas require record `version`; Action metadata explicitly marks concurrency role | Action concurrency projected separately from semantic input; ordinary CRUD detail is available in Model Contract | all ordinary mutations use current version boundary | optional lifecycle `true` assertion is representation-only by spec | aligned |
| soft deletion | Model Definition v1 Runtime invariant | DELETE operation exists; no per-model hard-delete switch | not separately advertised as a model-specific strategy | ordinary deletion is logical for every v1 model | lifecycle assertion add/remove compatible by normative spec | aligned |

### 3.3 Policy and Record Action semantics

| Feature | Canonical source | Validator | Contract / Discovery projection | Runtime | Compatibility / evidence | Status |
|---|---|---|---|---|---|---|
| Policy operations create/read/update/delete | Policy v1 | closed operation/reference matrix validated | Policy AST is intentionally not exposed as a client-side authority predictor | Policy may only narrow already-established outer authority; denies at execution | any Policy semantic change conservatively breaking | aligned |
| Policy eq/neq, all/any/not | Policy v1 | bounded depth/node/type checking | server-internal enforcement semantic | deterministic evaluator | validator + integration deny/positive tests exist | aligned |
| Policy actor/input/record refs | Policy v1 | operation-specific reference availability validated | not a client authorization lease | evaluated with current actor/input/record context | semantic changes breaking | aligned |
| Record Action key/access | Action v1 | bounded key/count/access validation | generated action route; Discovery exposes action key/access/kind | Runtime resolves active model/action and rechecks access | removal/change breaking; additive action currently compatible | aligned |
| Workflow Action semantic input | Action v1 currently has no custom caller-owned semantic inputs | no custom Action input DSL exists | Discovery correctly exposes `input.fields=[]`; Model Contract body contains concurrency evidence only | Runtime consumes deterministic declared transition | future semantic Action parameters are explicitly outside current v1 until DSL extension | aligned |
| Capability Action semantic input (`record-occurrence`) | Temporal Capability | Capability definition/runtime constraints | Discovery exposes occurredOn/note separately from concurrency; Model Contract generates request schema | Temporal runtime revalidates anchor/current Space semantics | capability config changes breaking | aligned |
| Action concurrency evidence | Generic Runtime invariant | separate from Action DSL | `x-lifespace-concurrency` + Discovery `concurrency` metadata | stale version denied | test/spec explicitly prevent treating `version` as semantic input | aligned |
| Action Policy / Guards / Branches / set | Action v1 | closed bounded DSL validation | internal transition logic is not exposed for clients to pre-authorize or reimplement; client sees callable Action | Runtime evaluates Policy → Guards → Branch → set and validates result | action semantic change breaking | aligned |
| Actor references in Action | Action v1 + shared actor vocabulary | validator consumes shared `ACTOR_TYPES`; prior #102 closed | no extra client input needed | delegated Agent execution covered by Agent-ready work | #102 completed alignment | aligned |

### 3.4 Capability and reference semantics

| Feature | Canonical source | Model Contract | Discovery | Runtime / evidence | Status |
|---|---|---|---|---|---|
| Capability inventory | registered Capability definitions | `x-lifespace-models[*].capabilities` | capability names projected | registered Capability runtime only | aligned |
| Calendar field-role binding | Calendar Capability definition | Calendar create/update/query shape generated | full stable Calendar field-role binding projected | Calendar runtime validates timed/all-day semantics | aligned |
| Temporal field-role binding | Temporal Capability definition | Temporal computed/query/action behavior generated | capability name exists, but no Temporal field-role binding object is projected | Temporal runtime depends on kind/anchor/cycle/attention/status/subject bindings | **gap** |
| Temporal computed projection | Temporal Capability | resource `computed.temporal` schema generated | capability identity/action is visible; computed result shape is available in full Model Contract, not Discovery | Temporal runtime computes current semantic state | aligned for full contract; progressive detail needed before compact Discovery can replace aggregate detail |
| Person Relation Target Lookup contract | relation field + Space Person | relation structure in generated schema | lookup method/path/search/cursor/limit is self-described | current-authority read + read Policy + bounded Space Person query | aligned |
| Ordinary-record reference label / target lookup | no current canonical record label semantic | cannot generate label projection | explicit unsupported reason | Runtime deliberately refuses generic record target lookup | **gap owned by #155** |
| Batch Reference Resolution / hydration | #165 target semantic, not currently implemented | absent | absent | no generic batch `ids -> resolved/unavailable` primitive | **gap — required before generic relation hydration can avoid per-ID consumer waterfalls** |

## 4. Matrix B — Dynamic Context & Authority

| Projection | Authority inputs / source | Output minimization | Freshness / cache safety | Batch / pagination | Deny / mutation recheck | Current evidence | Status |
|---|---|---|---|---|---|---|---|
| Cross-Space `/me/_discovery` | credential scopes + App×Model catalog + active Membership/Data Grant + active Delegation when actor=agent + active published models | only Spaces with at least one visible model; Space id/name + effective model projection | request-current authority facts; may be cached for UX but never used as execution proof | authority statements batched; result itself currently unpaginated | invisible models omitted; execution rechecks authority | M0-B: 2 D1 trips independent of measured S×M; payload grows to ~397 KB/128 DTO | **gap on progressive compactness, not authority correctness** |
| Single-Space Discovery | same intersection for one requested Space | one Space + effective models | request-current | one current-state D1 batch plus Registry read | nonexistent Space 404; unauthorized models omitted; execution authoritative | M0-B: 2 D1 / 12,406 B for 4 models | aligned, subject to same future progressive detail design |
| Effective model access | scopes ∩ application_model_access ∩ Membership/Data Grant ∩ model declaration ∩ Delegation when applicable | only allowed read/write/manage levels | point-in-time only | computed within Discovery batch; Runtime authorization has own bounded path | current Runtime rechecks | authorization/runtime/discovery tests | aligned |
| Effective Action visibility | effective model access ∩ Action access / capability action availability | only actions whose access is currently visible | point-in-time hint, not promise action guard/policy will succeed | derived in-memory from current model + authority | Action Policy/Guard/current record/version rechecked at execution | Runtime Discovery + Workflow/Mutation Authority tests | aligned |
| Membership effect | active non-deleted membership and active Space | role contributes authority rank | request-current; revoke/leave/close must affect subsequent checks | batched in Discovery | Runtime rechecks Space authority | authorization/space lifecycle tests exist | aligned semantics; systematic cross-source transition harness still missing |
| Data Grant effect | active, unexpired, unrevoked Space/model grant | permission contributes only relevant Space/model access | request-current | batched in Discovery | Runtime rechecks grant/current state | model-scoped grant tests | aligned semantics; systematic transition harness still missing |
| Application × Model Access | current application_model_access ceiling | only models/levels below application ceiling | request-current | one catalog statement in Discovery batch | Runtime rechecks application ceiling | generic resource/discovery tests | aligned semantics; systematic transition harness still missing |
| Agent Delegation | principal user + actor agent + application + Space + model max access + active/unexpired/unrevoked delegation | only delegated model levels | request-current | one additional statement inside same Discovery D1 batch; no extra round trip | Runtime rechecks current delegation | M0-B delegated Agent remains 2 D1; Agent-ready/delegation tests | aligned |
| Person Relation Target Lookup | current model read authority + model read Policy + current non-deleted Space People | minimal `{id,label}` | request-current selector hint only | `q<=100 chars`; cursor; limit 1–100; query fetches limit+1 | returned target is not write authority; mutation relation/Policy/current authority rechecked | M0-B limit 1 and 100 both 2 D1 | aligned |
| Record Relation Target Lookup | requires canonical model-owned reference label first | none | n/a | n/a | explicit `RELATION_TARGET_LOOKUP_UNSUPPORTED` | #155 | **gap owned by #155** |
| Batch Reference Resolution | must intersect current reference visibility/authority and return opaque partial status | preferred per-id `resolved` or opaque `unavailable` | request-current; cached display must not become proof | must be batch-bounded, not per-ID | unavailable must not leak missing/deleted/hidden/forbidden distinction | no implementation yet | **gap** |
| Model publish/retire effect on Discovery | active published Registry | only current active model version | current projection; exact historical mct remains evidence only | current aggregate reads published set | ordinary Runtime resolves current active descriptor | model Registry/contract tests | aligned |
| Dynamic revocation/concurrent-boundary conformance | committed authority mutation must be observed by auth checks started after commit | n/a | normative current-state requirement | controlled tests should place checks on both sides of commit | no cancellation promise for a check already completed before revoke commit | individual authority tests exist, but no unified state-transition matrix/harness | **gap in conformance coverage, not a proven authority semantic bug** |

## 5. Matrix C — Evolution & Compatibility

Three identities remain deliberately separate:

```text
Exact immutable artifact    mct_<hash>
Semantic compatibility      initial | compatible | breaking
Active Runtime              one currently published model version per model key
```

| Change / concern | Current automatic classification / behavior | Consumer consequence | Physical/runtime consequence | Status |
|---|---|---|---|---|
| First model publication | `initial` required | new capability | physical schema + active contract created | aligned |
| Same definition republish | rejected as unchanged | none | no duplicate version | aligned |
| Optional new field | compatible unless another semantic makes it breaking | Discovery/contract refresh/regeneration useful | additive physical column when applicable | aligned |
| New required field with valid server default | compatible by current classifier | consumers may omit on create; refreshed schema sees field | additive/backfill/publication planner must succeed | aligned |
| New required field without default | breaking | coordinated consumer migration required | physical/publication requirements must succeed before activation | aligned |
| Existing field type/constraint/default behavior change | breaking | regenerate/review consumers before activation | may require migration; destructive unsupported shapes remain blocked | aligned |
| Existing field removal | breaking | coordinated migration | destructive physical change requires explicit safe path | aligned |
| Query searchable/filterable/sortable removal | breaking | consumer query behavior would regress | no multi-version Runtime bridge is implied | aligned |
| Query capability addition | compatible | refresh allows new operation | no old consumer break | aligned |
| Access level removal | breaking | affected consumer loses declared operation class | authority remains current | aligned |
| Policy semantic change | breaking (conservative) | behavior can deny differently | coordinated review | aligned |
| Capability configuration change | breaking (conservative) | semantic role/query behavior may change | capability projection/storage migration may apply | aligned |
| Existing Action removal/change | breaking | tool/action consumers must migrate | current single active version changes after activation | aligned |
| New Action | compatible | regenerated/Discovery consumers may discover it | additive | aligned |
| Lifecycle assertion add/remove | compatible representation change by normative spec | no behavior change: concurrency + soft delete are invariant | no strategy switch | aligned |
| Exact Model Contract identity | hash over canonical manifest + generated OpenAPI + JSON Schema | exact reproducible codegen/evidence input | old mct existence does not keep historical Runtime version executable | aligned |
| Active model version | Registry maintains one published version per model key; old rows become historical/superseded | dynamic consumers refresh current detail | v1 intentionally has no multi-version serving | aligned |
| AI Proposal publication minimum compatibility | Core proposal stores `recommendedCompatibility`; breaking proposal cannot publish as compatible | prevents under-classification on AI path | normal publication still performs physical checks | aligned |
| Direct Model Admin publication minimum compatibility | caller supplies `compatibility`; `publishModelDefinition()` checks first/subsequent `initial` validity but does not compare requested level with `diffModelDefinition()` | caller can currently understate a breaking existing-model change as `compatible` | risks activating breaking semantics without the intended migration signal | **gap under #165 compatibility gate** |
| Stable Public code-owned OpenAPI schema-level compatibility | first-stage fingerprints/semantic locks exist | model contract concern is separate | schema-aware Stable Public diff strengthening remains | **gap already owned by #130; do not duplicate here** |

### 5.1 Compatibility conclusion

`diffModelDefinition()` already provides a useful minimum classifier and the AI Proposal path proves the intended enforcement shape is viable. The missing part is not a new compatibility DSL; it is applying the same minimum-classification principle to the authoritative generic publication path.

Required rule remains:

```text
automatic minimum = breaking + caller compatible -> reject
automatic minimum = compatible + caller breaking -> allow conservative over-classification
```

## 6. Matrix D — Performance / Freshness / Consumer Budget

| Projection / flow | Payload/cardinality | D1 / I/O shape | Freshness/cache class | Core HTTP shape | Recommended consumer representation | LLM/tool-context guidance | Status |
|---|---|---|---|---|---|---|---|
| Full immutable Model Contract (`mct_*`) | complete all-model generated OpenAPI/JSON Schema snapshot | generated at publication/control plane, not ordinary hot business request | immutable exact identity; safely cacheable by hash | control-plane retrieval/export rather than required Runtime preflight | **full Contract** for codegen/audit/schema-driven deterministic tooling | normally keep out of per-turn LLM context; select relevant subset in Adapter | aligned |
| `/me/_discovery` current aggregate | measured 3,053 B/1 DTO → 396,865 B/128 DTOs | 2 D1 trips in measured sweep; D1 count O(1) in S×M but DTO materialization/payload grows | request-current dynamic authority/context | one explicit request when caller wants complete current projection | current **full Context Projection**, not desired default bootstrap | do not inject wholesale | **gap: compact inventory/progressive detail required** |
| Single-Space Discovery | measured 12,406 B for 4 model DTOs | 2 D1 | request-current | one explicit request | scoped Context Projection | acceptable when caller has already selected Space; still avoid unnecessary full detail | aligned as scoped endpoint, future detail split may reduce payload |
| Delegated-Agent `/me/_discovery` | representative 5,710 B / 2 DTO | 2 D1 | request-current Delegation | one explicit request | dynamic Context Projection | Adapter should expose only task-relevant capabilities | aligned |
| Person Relation Target Lookup | 408 B at limit1; 6,322 B at limit100 in M0-B | 2 D1 at both measured limits; O(1) in result count at network-trip level | request-current selector context | only when relation selector/resolution is needed | dynamic bounded lookup | normally results, not full candidate universe, enter UI/agent context | aligned |
| Record Relation Target Lookup | unavailable | n/a | n/a | explicit unsupported result | blocked until #155 canonical label semantic | no adapter guessing | **gap #155** |
| Batch Reference Resolution | absent | absent | must be request-current visibility projection | should be one bounded batch request for many held IDs | dynamic Context Projection | expose only resolved labels needed for current result | **gap** |
| Ordinary list/query | normal data payload | Phase-3 budget <=5 D1; M0-B Task list remained 2 D1 before and after explicit Discovery | execution-current authority | no mandatory Discovery/Reference preflight | normal Runtime result | no projection tax | aligned |
| Stable Runtime descriptor | bounded by published model set per isolate | hot ordinary lookup 0 Registry D1 after snapshot load | stable semantic cache with 60s isolate snapshot + explicit local invalidation | internal, no consumer HTTP | internal compiled semantic representation | never injected | aligned |
| Runtime Discovery Registry component | aggregate Discovery currently calls `listPublishedModels()` directly, contributing one of its 2 D1 trips | bounded but not sharing ordinary hot descriptor snapshot | stable semantics + request-current authority are currently assembled separately | no waterfall, but one avoidable stable Registry read may exist | optimization candidate only | irrelevant to token budget | **not a gate failure; profile before optimizing** |

### 6.1 Consumer request-shape conclusion

M0-B proved that current platform I/O is structurally feasible, but the aggregate DTO growth means the final Generic Consumer path must become progressive:

```text
compact current capability inventory
  -> select relevant Space/model/capability
  -> load detailed stable semantics only when needed
  -> load dynamic relation/reference context only when needed
  -> execute normal Runtime mutation/query
```

The current full Model Contract cannot simply replace the aggregate Discovery bootstrap: it is an immutable complete artifact/control-plane product, while Runtime consumers need a safe, authority-aware and progressively loadable client projection.

## 7. Proven gap register

| Gap | Root concern | Existing owner | M0 classification | Do not solve by |
|---|---|---|---|---|
| G1 | Direct Model Admin publish can under-classify automatic breaking change | #165 | compatibility gate | adding another compatibility DSL |
| G2 | Temporal stable field-role bindings are absent from Runtime Discovery client projection | #165 | static semantic projection | teaching n8n/MCP/ALOHA DayRecord-specific field names |
| G3 | Capability-specific query params/sort semantics and generic numeric/date range operator shape are not completely self-described by Runtime Discovery | #165 | static semantic projection | hard-coded Adapter conventions copied from current URLs |
| G4 | Ordinary record relations have no canonical generic reference label / target lookup | #155 | reference semantic | guessing `name`/`title`/`summary` in Adapter |
| G5 | Generic batch Reference Resolution/Hydration is absent | #165, with record-label dependency on #155 | dynamic projection / bounded cost | one HTTP/D1 resolution per relation ID |
| G6 | Compact capability inventory + progressively loadable runtime semantic detail do not yet exist; current aggregate Discovery grows with S×M | #165 | performance/client projection | default full `/me/_discovery` injection or speculative distributed cache |
| G7 | Normative Conformance-ID + independent Oracle fixture coverage gate is not implemented | #165 | static conformance | self-confirming generator-vs-runtime tests only |
| G8 | Unified dynamic state-transition / concurrent revocation harness is not implemented across all mutable authority sources | #165 | dynamic conformance | treating cached positive Discovery as authority |
| G9 | Stable Public code-owned OpenAPI schema diff is weaker than desired | #130 | separate Stable Public representation follow-up | folding code-owned OpenAPI policy into Model Definition compatibility |

No M0 evidence currently justifies a second semantic source, Core-owned natural-language tool router, distributed cache tier, multi-version Runtime, renderer DSL, or field-level conditional authorization.

## 8. Already-correct behavior that should not be redesigned

The audit also identifies substantial current behavior that should be preserved rather than rewritten merely because #165 is active:

- the 13-type Model Definition v1 vocabulary and closed validator;
- Generic Runtime typed descriptor/snapshot discipline for ordinary hot requests;
- field title/description + readOnly/immutable/default/constraint projection;
- Action semantic-input vs concurrency separation;
- server-authoritative Policy/Guard/Branch behavior instead of client-side authorization prediction;
- Calendar stable field-role binding;
- Person Relation Target Lookup source-field awareness, current authority and bounded cursor pagination;
- explicit unsupported record lookup rather than Adapter heuristics;
- current Effective Authority intersection and execution recheck;
- immutable `mct_*` identity separate from compatibility and active Runtime;
- single-active-model-version v1 decision;
- Phase-3 ordinary Runtime round-trip budgets;
- M0-B result that Generic Consumer projection is opt-in and adds zero mandatory D1/HTTP tax to ordinary list execution.

## 9. M0 exit assessment

M0 inventory is sufficiently materialized to enter focused M1/M2 audits **without starting a broad Runtime rewrite**.

M0 has proved that the likely implementation work is a set of bounded, separable gaps rather than a need to replace Generic Runtime:

1. compatibility minimum enforcement on generic model publication;
2. semantic client-projection completeness (Temporal/query semantics);
3. progressive compact inventory/detail shape;
4. reference-label/resolution closure (#155 + batch resolution);
5. static Oracle coverage and dynamic transition harnesses.

Before any M3 implementation, M1/M2 should turn each gap into a mechanically testable acceptance contract and decide whether it changes Kernel representation/versioning or remains an additive Candidate projection.

## 10. Next recommended sequence

```text
M1 Static audit
  1. define exact client-projection requirements for G2/G3/G6
  2. define Conformance-ID / Oracle fixture coverage model for G7
  3. close compatibility publication-loop audit for G1

M2 Dynamic audit
  4. define batch Reference Resolution security/partial-result contract for G5
  5. bind record-label dependent work to #155, do not duplicate it
  6. define state-transition/concurrent-boundary cases for G8
  7. reuse M0-B metrics as fixed performance acceptance boundary

M3 only after those contracts are reviewable
  -> one focused issue/PR per proven gap
```
