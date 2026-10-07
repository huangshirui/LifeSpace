# LifeSpace Contract Stability Policy

Status: **M4 Contract Baseline normative policy**

This document defines what LifeSpace promises to keep compatible, what may still evolve, and how public contract changes are classified.

It complements `docs/north-star.md`, `docs/architecture.md`, `docs/contracts.md` and `docs/permissions.md`. The machine-readable companion is `docs/contract-stability-baseline.json`.

## 1. Two independent dimensions

Every platform capability or contract surface is classified on two independent axes.

### Maturity（成熟度）

- **Stable（稳定）** — the classified semantics or representation has enough evidence that consumers may rely on compatibility. Breaking change requires an explicit deprecation/migration process rather than an ordinary edit.
- **Candidate（候选）** — the direction is intentionally supported and tested, but representation or detail may still change. Breaking change is allowed only with explicit impact analysis and migration evidence for known consumers.
- **Experimental（实验）** — exploration with no long-term compatibility promise. It must still preserve security, authorization, data integrity and repository safety.

### Visibility（可见性）

- **Public（公开契约）** — forms a Consumer Contract for an application, service, Agent, adapter or other supported caller.
- **Internal（内部契约）** — implementation, provisioning, control-plane or operational surface whose lifecycle is not part of the ordinary Consumer Contract Baseline.

`Internal` is not a fourth maturity value. An internal surface can still be Stable or Candidate for operational reasons.

A URL segment named `/internal` does not automatically mean `visibility=internal`: if a trusted application backend is an intended independent consumer, that operation still forms a Public Consumer Contract. Conversely, a documented platform-admin or bootstrap operation may remain Internal for the first Contract Baseline even though it has an explicit OpenAPI description.

## 2. Semantic stability is not representation stability

LifeSpace stabilizes durable meaning before freezing replaceable protocols.

A capability may therefore have:

```text
semantic maturity       = stable
representation maturity = candidate
```

This is intentional for areas such as Runtime Discovery（运行时发现） and Agent Delegation（Agent 委托）. The invariant that effective authority is current, bounded and revocable can be Stable while today's HTTP path, JSON shape, token/session representation or adapter protocol remains Candidate.

Do not infer that a Stable semantic invariant freezes:

- a REST path;
- a JSON property name;
- a JWT claim layout;
- a Cloudflare transport choice;
- an MCP/OpenAI Tool schema;
- a workflow-node representation;
- a product-specific Agent Runtime/Capability shape.

Those representations receive their own classification.

## 3. Stable Spine（稳定骨架）

The first Contract Baseline classifies the following semantic invariants as Stable:

1. **Space Boundary（Space 边界）** — durable Shared Reality belongs to one source Space; Spaces are isolated by default; cross-Space sharing is explicit, bounded and revocable and does not move ownership.
2. **Global User Identity（全局用户身份）** — one LifeSpace `usr_*` is global across applications; application/provider identities are mappings, not parallel LifeSpace users.
3. **Principal / Actor / Application Attribution（权限主体 / 执行者 / 应用归因）** — whose authority is exercised, who executes, and through which application context remain distinguishable when they differ.
4. **Effective Authority Intersection（有效权限交集）** — ordinary access cannot exceed verified credential scope ∩ Application × Model Access ∩ current Space membership/Data Grant ∩ published model capability/policy; delegated Agent execution additionally requires current Delegation.
5. **Model Semantic Ownership（模型语义所有权）** — canonical Model Definitions / Registry own ordinary model semantics; generated Model Contract revisions and protocol adapters are projections, not second semantic sources.
6. **Generic Runtime Fundamentals（通用运行时基本语义）** — validation, declared server defaults, optimistic concurrency, Action semantic input, and Mutation Authority are Runtime-enforced rather than client conventions.
7. **Governed Change Attribution（受治理变更归因）** — committed ordinary-model mutation evidence preserves operation/resource/version plus Principal, Actor, Application and Delegation where applicable.
8. **Current-State Revocation（当前状态撤销）** — mutable Membership, Data Grant, Application × Model Access, Service Principal and Agent Delegation authority is rechecked from current state; stale credentials do not preserve revoked authority.
9. **Agent Product / Protocol Independence（Agent 产品与协议无关）** — Agent Ready is a platform capability. REST, MCP, OpenAI/API Tool, workflow integrations, SDKs, product Agent runtimes and future protocols are adapters over the same authority and model semantics.

These are semantic commitments. Their current wire forms are classified independently in the machine baseline.

## 4. Candidate semantic areas

The following remain Candidate at the first Baseline unless separately promoted by evidence:

- the exact Runtime Discovery projection model beyond the Stable current-authority/recheck invariant;
- the exact Agent Delegation granularity beyond explicit bounded delegation + current revocation;
- Integration/Eventing API and delivery representation beyond the established reference-only, authorization-preserving direction;
- richer Data Grant target types beyond currently implemented whole-Space and model-collection semantics;
- future Shared Knowledge representation;
- generic idempotency / uncertain-write contracts across services;
- richer presentation/relation-selector metadata;
- protocol-specific Agent adapters.

Candidate is supported, not disposable. A Candidate breaking change must be deliberate and migratable.

## 5. Experimental / non-baseline areas

The first Baseline does not promote these to the Stable Spine:

- product-side creation interpretation / natural-language interpretation representation;
- AI Model Designer interaction mechanics;
- speculative Domain Pack packaging;
- future approval/proposal/compensation frameworks not yet demanded by a concrete high-risk operation;
- protocol-specific generated MCP/OpenAI Tool forms that do not yet have an independent compatibility lifecycle.

Experimental status never permits bypassing Stable Authority, Change, security or data-integrity invariants.

## 6. Change classes

Every public change must be reviewed as one of:

### Additive（增量兼容）

Existing valid requests and documented responses keep their meaning. Examples:

- adding an optional response field that consumers are required to ignore when unknown;
- adding a new optional capability or model that existing applications are not automatically authorized to use;
- adding a new enum only where the contract explicitly defines unknown-value tolerance.

An addition is **not** automatically compatible merely because old fields remain. New required behavior, changed defaults or changed authorization meaning can be behavioral/breaking.

### Behavioral（行为变化）

Wire syntax may remain valid while meaning changes. Examples:

- changing a server default;
- changing authorization or revocation timing;
- changing lifecycle transition semantics;
- changing sorting/filtering meaning;
- changing which mutation path owns an invariant.

Behavioral changes must be evaluated against the maturity of the affected semantic commitment. A Stable behavioral invariant cannot be changed silently under the same contract merely because OpenAPI diff appears additive.

### Breaking（破坏性）

A supported consumer must change to preserve behavior. Examples:

- removing/renaming an operation or required field;
- narrowing accepted input without an established validation bug/security exception;
- changing response shape in a way old consumers cannot safely tolerate;
- changing Stable semantic meaning;
- retiring a model/capability still used by a pinned consumer.

Security fixes may require urgent incompatibility, but must still be recorded as an explicit exception with impact and migration/containment reasoning.

## 7. Compatibility requirements by maturity

### Stable

Stable Public changes require:

1. identify the Stable semantic/representation being changed;
2. prove additive compatibility or use explicit deprecation/migration;
3. preserve existing Golden Flow evidence or update it with equivalent/stronger coverage;
4. document downstream impact;
5. for removal/rename, provide a replacement path and deprecation period when operationally possible;
6. never downgrade `stable -> candidate/experimental` merely to avoid compatibility work.

Promotion to Stable is explicit. Demotion requires an architecture decision showing that the earlier stability classification was wrong, not simply inconvenient.

### Candidate

Candidate Public breaking changes are allowed only when:

1. the reason is documented;
2. known consumers / Design Partners are identified;
3. migration evidence exists for affected current consumers or the capability is proven unused;
4. contract/version or immutable Model Contract evidence changes explicitly;
5. the change does not violate a Stable semantic invariant.

### Experimental

Experimental Public representations may move quickly, but any externally usable experiment must still state that status. Promotion to Candidate/Stable requires evidence rather than age.

## 8. Stable deprecation policy

Stable Public removal is a process, not a commit-time rename.

At minimum:

```text
replacement identified
-> deprecation recorded in canonical contract/docs
-> known consumers identified
-> migration/compatibility window established where feasible
-> consumer evidence moved to replacement
-> removal occurs in an explicit breaking release/migration step
```

The Baseline does not prescribe a universal calendar duration yet. The required window depends on consumer lifecycle and deployment ownership. What is forbidden is silent removal.

## 9. Versioning boundaries

LifeSpace keeps coarse contract families:

- **Identity Application Contract** — ordinary user/application/service/Agent identity and credential consumer syntax;
- **Reality Runtime / Core Kernel Contract** — Space/Authority/Runtime-facing Kernel syntax;
- **Model Contract Revision** — immutable generated ordinary-model OpenAPI/JSON Schema at `mct_*` content identity;
- **Integration / Eventing Contract** — LifeSpace-owned integration/event semantics in `apps/core/integration-eventing.openapi.yaml`, independently versioned and compatibility-checked even while executed by the same Core Worker;
- Platform Admin / Bootstrap / provisioning remain specialized/Internal for this Baseline.

A consumer that does not use Eventing must not be forced to pin or repin the Integration/Eventing contract. A consumer that configures Webhook Endpoints/Event Subscriptions or receives signed Eventing deliveries pins the Integration/Eventing version in addition to the Runtime/Model contracts it actually consumes.

Do not create a new version family merely because an implementation module or Worker exists.

A semantic compatibility break and a representation version bump are related but not identical: changing a version number does not make a Stable semantic break acceptable without migration evidence.

## 10. Model Contract rule

Ordinary model semantics remain owned by canonical Model Definitions / Registry and the existing Model publication compatibility gate.

For the first Contract Baseline, the **generated ordinary Model Contract representation family is explicitly `Candidate / Public`**. A newly published model therefore enters an already-declared evolution class rather than bypassing stability classification. This family-level classification avoids copying every generated Task/Event/future-model operation into a second handwritten list.

M4 does **not** create a second handwritten list of every generated model operation. Instead:

- Model Definition compatibility remains authoritative for logical model evolution;
- every active `mct_*` revision remains immutable evidence;
- generated OpenAPI/JSON Schema remains reproducible output;
- server defaults, Action semantic input/concurrency annotations and Runtime behavior must remain aligned;
- model retirement/breaking publication requires downstream dependency/migration evidence.

Promoting a particular generated representation family or model semantic promise to Stable later requires explicit evidence and classification; immutability of one `mct_*` snapshot alone is not such a promotion.

## 11. Adapter rule

REST, SDK, MCP, OpenAI/API Tool, workflow integrations and product-specific Agent integrations must project LifeSpace semantics.

An adapter may:

- transform transport;
- generate tool/forms/schema views;
- narrow the exposed capability set;
- resolve protocol-specific invocation details.

It must not:

- mint user authority;
- copy and independently evolve Model/Grant/Action semantics;
- turn a cached Discovery result into authorization proof;
- preserve revoked authority;
- make its protocol representation the platform semantic source.

## 12. Mechanical baseline

`docs/contract-stability-baseline.json` is the machine-readable baseline for code-owned OpenAPI surfaces, generated contract-family classifications and Stable semantic commitments.

`infra/scripts/check-contract-stability.mjs` validates operation coverage/classification during normal `pnpm check`. A second gate, `apps/core/scripts/check-stable-contract-compatibility.mjs`, compares canonical OpenAPI against generated accepted evidence in `docs/stable-public-schema-baseline.json.gz.b64` for **Stable / Public** representation groups only. The checked-in evidence is deterministically gzip+base64 encoded to keep the generated dereferenced snapshot compact; `pnpm --filter @lifespace/core stable-contract:baseline:print` renders the accepted JSON for review. It dereferences local schemas and rejects clear backward-incompatible representation changes such as operation/parameter/property removal, newly required input, request type/enum/constraint narrowing, removed responses/media types/headers, required-response weakening and incompatible response widening. Compatible additive optional input and additive response fields remain allowed.

The check intentionally fingerprints the complete code-owned OpenAPI operation set. Adding/removing an operation therefore requires an explicit baseline update even if the new operation happens to match an existing path family. Stable operation groups are fingerprinted separately, so refreshing a whole-contract fingerprint cannot silently remove an already-Stable operation.

Generated ordinary Model Contract surfaces are not copied into this operation inventory; their family classification is validated separately while Model Definition / Registry publication remains authoritative for their contents and compatibility.

Neither machine file is a replacement for canonical OpenAPI, Model Definitions or this policy. `docs/stable-public-schema-baseline.json.gz.b64` is generated acceptance evidence, not an editable semantic source: deliberate Stable breaking evolution must use the documented deprecation/migration process rather than refreshing the evidence to silence CI. Candidate/Experimental surfaces and generated ordinary Model Contracts keep their existing weaker/Model-publication compatibility rules.
