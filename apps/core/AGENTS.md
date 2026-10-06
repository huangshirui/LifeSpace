# Core contributor instructions

This file extends the repository-root `AGENTS.md` for `apps/core/**`.

## North Star

`apps/core` is the platform Runtime + Model Platform + Authority implementation. It must remain generic enough for multiple applications to share one reality model without forcing application-specific CRUD, authorization, or storage conventions into Kernel code.

## Model Platform

- `apps/core/model-catalog/baseline-models.json` is the single editable repository source for shipped ordinary Model Definitions.
- Runtime/test exports in `src/builtin-models.ts`, deployment semantic projections, contract-generation inputs, and verification derive from the catalog.
- SQL migrations preserve immutable publication history; they are not the current semantic authoring source.
- Generic CRUD/query/action/Batch behavior derives from published Model Registry state and validated Model Definition DSL.
- Do not add first-class CRUD endpoints for an ordinary business model merely because it is shipped by LifeSpace.
- A model-specific implementation is justified only when it is a standard platform Capability or Kernel semantic, not application convenience.

## Kernel versus ordinary models

- Kernel owns Identity/Authority integration, Space, Membership, Data Grant, Delegation, Person anchor state, Model Registry/control plane, governed Change evidence, Runtime Discovery, contracts, Eventing/Webhook infrastructure, and other platform invariants.
- Ordinary business/domain state belongs to metadata-driven models, even when LifeSpace ships the baseline definition.
- `Space Person (per_*)` is Kernel reality-anchor state and remains distinct from global User identity. Person-facing ordinary models may reference Person but do not replace the anchor.

## Authority

- Authentication proves Application + Principal + Actor identity. Credential possession alone is never Resource Authority.
- Runtime authority is the intersection of credential scope, Application × Model access where applicable, current Space/Data Grant Authority, declared model access, explicit Delegation when Principal/Actor differ, and Policy.
- Delegation is an explicit immutable scope with current-state validation. Represented execution must not select an implicit active Delegation.
- Root/Child Delegation chains preserve Root Principal identity and enforce strict narrowing; bounded re-delegation is governed by Entity Role Capability and remaining depth.
- Single-use Delegations must be consumed only as part of the successful governed operation/read semantic defined for that route; avoid pre-consuming an authority token before a mutation that can still fail.
- Principal Person and Actor Person are Policy/business-semantic identities, not alternate Authority sources.

## Performance

- Treat Worker→D1 / Worker→external round trips as a first-class acceptance metric.
- Avoid per-record, per-relation, per-person, per-Delegation-depth, or per-batch-item network waterfalls.
- Prefer bounded set-wise snapshots/queries; keep D1 bind counts within repository budgets.
- Local wall-clock latency is diagnostic only unless the test specifically represents the accepted deployment path/region.
- New convenience semantics must not introduce unbounded generic-runtime fan-out.

## Model Definition / storage

- Validated Model Definition is the semantic source of truth for ordinary models.
- Physical typed tables/indexes derive from the schema planner/compiler.
- Relations remain generic reference projections unless a standard Capability explicitly owns auxiliary storage.
- Search/filter/sort behavior must follow declared/query semantics rather than guessed conventional field names.
- Canonical reference labels are model-owned `referenceLabel` semantics, with stable record-ID fallback where declared.

## Contracts

- `apps/core/openapi.yaml` is the Kernel application/runtime contract.
- Ordinary model CRUD/query/action/Batch syntax belongs to immutable generated `mct_*` Model Contract Revisions, not the Kernel OpenAPI.
- Registry governance belongs to `model-control-plane.openapi.yaml`.
- Integration/Eventing belongs to `integration-eventing.openapi.yaml`.
- Platform-admin syntax belongs to `platform-admin.openapi.yaml`.
- Contract version, runtime `CORE_KERNEL_CONTRACT_VERSION`, Status response, package version, compatibility evidence, and staging expectations must converge before merge.

## Migrations

- Kernel/platform migrations remain under `apps/core/migrations`.
- Ordinary model physical schema is produced by validated model publication/schema planning, not one repository migration per ordinary model.
- Kernel/control-plane tables remain explicit.
- Capability auxiliary tables/indexes are allowed when needed for correctness/performance.
- Event outbox/Webhook Endpoint/subscription/delivery tables are explicit Kernel infrastructure, not ordinary business models.
- Migration and Worker rollout order must remain compatible and documented.

## Contract ownership

Business-facing Core Kernel contract:

```text
apps/core/openapi.yaml
current Kernel version: 0.47.0
```

Integration/Eventing public contract (same Worker, independent lifecycle):

```text
apps/core/integration-eventing.openapi.yaml
current Integration/Eventing version: 0.4.0
```

Model Registry / Model Contract governance contract:

```text
apps/core/model-control-plane.openapi.yaml
current Model Control Plane version: 0.2.0
```

Core Platform Admin companion contract:

```text
apps/core/platform-admin.openapi.yaml
current Core Platform Admin version: 0.3.0
```

## Production documentation

- Repository/main/staging capability is not Production availability.
- `docs/production/*` is the source for currently deployed Production contract/schema/model availability.
- After a successful Production release, refresh the human-readable Production feature/whitepaper material required by the root instructions.
