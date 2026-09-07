# Generic Consumer Readiness v1 — M4 Acceptance

Status: **M4 acceptance passed**  
Date: **2026-09-07**  
Owning issues: **#165 Generic Consumer Readiness v1**, **#193 M4 acceptance harness**

## 1. Acceptance question

M4 answers the final v1 platform question:

> Can a consumer with no handwritten knowledge of Task/Event/Wish or another shipped business model start from current compact context, load only one relevant model's semantics, derive an executable representation, use dynamic relation projection safely, execute canonical operations, and still fail closed after current authority changes?

The answer on current `main` is **yes** for the current Model Definition v1 / Generic Runtime scope.

M4 did not require another Runtime redesign or a new public contract. The acceptance slice adds test/evidence only.

## 2. Model-neutral end-to-end proof

`apps/core/test/generic-consumer-v1-acceptance.integration.test.ts` publishes two synthetic unfamiliar ordinary Model Definitions and gives the test principal current access to both. The consumer then selects only one model and operates it without a model-key-specific semantic branch.

The selected synthetic model exercises representative current v1 semantics:

- required string field;
- enum field with authoritative server default;
- date/query metadata;
- Person relation;
- ordinary Generic Runtime create/list behavior;
- one Record Action;
- Action semantic input separated from record-version concurrency;
- current Application × Model Access revocation.

The acceptance flow is:

```text
GET /api/v1/me/_discovery/inventory
  -> choose one current Space/model edge
  -> GET advertised single-model semantic detail
  -> derive writable/default/query/action representation
  -> GET Person Relation Target Lookup only when relation input is needed
  -> POST canonical create
  -> GET canonical list/query
  -> POST canonical Action with concurrency evidence
  -> POST batch Reference Resolution for already-held Person IDs
  -> commit current App × Model Access revocation
  -> reuse previously fetched projection and attempt canonical create
  -> 403 from current authoritative execution
```

The consumer does **not** call aggregate `GET /api/v1/me/_discovery` and does not download the unrelated synthetic model's semantic detail.

## 3. Progressive locality and cost evidence

CI Check #1214 emitted this representative local-D1 diagnostic for the M4 flow:

| Step | Response bytes | Notes |
| --- | ---: | --- |
| compact current inventory | 919 B | two visible model identities are present |
| selected model semantic detail | 2,391 B | only one model detail is fetched |
| Person Relation Target Lookup | 198 B | loaded only when relation candidate selection is needed |
| create response | 586 B | canonical Runtime execution |
| list/query response | 628 B | canonical Runtime execution |
| Action response | 602 B | canonical Action execution |
| batch Reference Resolution | 228 B | one bounded batch for held IDs |
| post-revocation denied create | 207 B | stale positive projection does not restore authority |

Observed request-shape assertions:

- visible model identities in compact inventory: **2**;
- selected model detail requests: **1**;
- full aggregate Discovery requests: **0**;
- Relation Target Lookup requests: **1**;
- Reference Resolution requests: **1**;
- total HTTP requests in this representative end-to-end task: **8**.

These byte values come from Cloudflare Vitest local D1 and are evidence of request/payload locality, not APAC production latency measurements.

This sits on top of the earlier M3 structural evidence:

- compact inventory at 32 Spaces × 4 Models: **11,078 B** vs full aggregate Discovery **415,969 B**, byte ratio **0.0266**, with the same bounded 2 D1 round trips;
- single-model semantic detail hot path: **1 D1 round trip**;
- batch Person Reference Resolution: **2 D1 round trips** for 1, small and max-50 batches, with no per-ID waterfall;
- ordinary CRUD/query/action has **zero mandatory Discovery/inventory preflight tax**.

Therefore a local task no longer requires downloading or injecting the full LifeSpace semantic world.

## 4. What the generic consumer can recover without model-specific hardcoding

From compact inventory + one static semantic detail + generic Kernel relation operations, a deterministic consumer can recover the current facts needed to build a functional representation:

- current reachable Space and model identity;
- current coarse effective model access for that Space;
- route and display metadata;
- field type/title/description/required/nullability/constraints;
- readOnly / immutable Mutation Authority boundaries;
- authoritative server defaults and omission behavior;
- query/search/filter/range/sort/pagination semantics;
- Action identity, invocation, required access and semantic input;
- optimistic-concurrency transport separately from Action business input;
- Capability bindings for current Calendar/Temporal semantics;
- relation target model/cardinality and held-ID resolution semantics;
- current dynamic relation candidates through Relation Target Lookup;
- minimal current display references through bounded Reference Resolution.

A consumer still must not reproduce server-internal Policy ASTs, guards, transition assignments, Membership/Data Grant internals or current authorization calculations. Those remain authoritative in LifeSpace execution.

## 5. Representative consumer categories

### Generic deterministic client / schema-driven UI

**Accepted at Core boundary.**

M4 directly proves a deterministic consumer can derive ordinary form/query/action behavior from platform metadata. A generated/schema-driven UI can therefore build generic controls from the same facts.

Layout, widget choice, grouping, visual hierarchy and product interaction policy remain Adapter/Experience concerns; M4 does not introduce a renderer/layout DSL into Core.

### Delegated Agent

**Accepted by existing current-authority evidence.**

The M3 inventory/detail tests plus the dynamic authority state-transition harness already prove that delegated-Agent visibility is narrowed by current Delegation and that an already-issued delegated JWT cannot restore authority after Delegation revoke. M4 found no additional Agent-specific Core semantic gap.

Agent/Product runtimes still own conversation-aware capability selection and orchestration.

### n8n

**Semantic consumption proven; progressive adoption remains adapter work.**

The existing `lifespace-n8n-nodes` implementation already uses LifeSpace metadata to drive:

- Space and Record Type selection;
- generated writable field mapping;
- field titles;
- authoritative server-default omission;
- typed query/filter/sort behavior;
- Action semantic input vs concurrency;
- Space labels;
- Person Relation Target Lookup.

Its current code still uses full `/me/_discovery` as the discovery source and its documented compatibility baseline predates the progressive inventory/detail contract. That is an adapter payload/locality adoption gap, not a missing Core semantic.

Tracked separately as `huangshirui/lifespace-n8n-nodes#22`.

### MCP / API Tool projection

**Core prerequisite accepted; adapter implementation still pending.**

The `lifespace-adapters` MCP area is currently bootstrap/design documentation rather than a completed protocol adapter. M4 confirms Core now provides the required consumer-neutral information path:

```text
compact current inventory
  -> adapter-owned select/rank/top-K
  -> relevant static model detail
  -> lazy dynamic relation/reference context
  -> canonical execution with current-authority recheck
```

MCP tool naming, ranking, top-K selection, tool-count/token budgets and protocol caches remain Adapter responsibilities. Full-world Discovery must not become the universal LLM tool-context default.

Tracked separately as `huangshirui/lifespace-adapters#4`.

## 6. Final v1 boundary

M4 found **no additional Core semantic or Runtime gap** inside #165's accepted v1 scope.

The resulting boundary is:

### Core owns

- semantic completeness for current Model Definition v1 / Capability semantics;
- compact current capability inventory;
- progressively loadable static model semantic detail;
- current relation lookup/reference resolution primitives where canonical labels exist;
- current Authority/revocation correctness;
- canonical CRUD/query/Action execution;
- bounded D1/request/payload behavior;
- compatibility/conformance gates.

### Adapters own

- protocol-specific projection;
- capability retrieval/ranking/top-K;
- MCP/OpenAI Tool/n8n/SDK representations;
- token/tool-count budgets;
- protocol caches and refresh policy that never become authorization proof.

### Product / Agent Runtime owns

- conversation-aware routing across LifeSpace and non-LifeSpace capabilities;
- product-specific confirmation and orchestration;
- generated UI/layout/presentation policy.

The project-level principle remains:

> **Discoverable does not mean injected into every LLM context.**

## 7. Remaining work outside #165

The following remain intentionally separate and do not reopen Generic Consumer Readiness v1:

- **#155** — canonical ordinary-record reference label semantics. Until it lands, `record` / `record_list` generic label lookup/resolution remains explicitly unsupported rather than guessed from fields such as `name` or `title`.
- **#130** — stronger schema-aware Stable Public OpenAPI compatibility diff gate.
- **lifespace-n8n-nodes#22** — adopt compact inventory + selected model detail.
- **lifespace-adapters#4** — make progressive inventory/detail the default MCP discovery input when MCP implementation proceeds.

Any future new DSL semantic must continue to receive normative Conformance-ID + independent Oracle coverage, and any new dynamic authority source must receive state-transition/revocation evidence rather than relying on stale positive projections.

## 8. M4 exit decision

Generic Consumer Readiness v1 is accepted when this document and the M4 harness are merged with full repository Check green.

At that point #165 can close with this conclusion:

> **LifeSpace current v1 semantics are self-describing, progressively discoverable and bounded-cost at the Core boundary. Consumer-specific protocol/token/UI optimization now belongs outside Core unless a future concrete consumer proves a missing platform semantic.**
