# Core Agent Instructions

LifeSpace Core is the shared business platform and source of truth for Spaces, Data Grants, Application × Model Access, the Model Registry, Generic Runtime, metadata-driven life-domain records and platform Eventing. It also owns Core-side LifeSpace platform administration and audit for Core state.

## Before changing Core

Read:

1. root `AGENTS.md`;
2. `apps/AGENTS.md`;
3. `docs/architecture.md`;
4. `docs/permissions.md`;
5. `docs/service-authentication.md` when changing service/machine/platform executors;
6. `docs/contracts.md`;
7. `docs/eventing.md` when changing Domain Events, subscriptions, Webhook delivery, queues or delivery diagnostics;
8. `docs/model-platform-architecture.md` when changing model/runtime architecture;
9. `docs/runtime-storage-performance.md` for persistence/query/performance changes;
10. `docs/generic-consumer-contract.md` for discovery/projection/reference-resolution changes;
11. the relevant Core contract, migrations, tests, Model Definitions and implementation.

## Core responsibilities

Core owns:

- Spaces, memberships and Space People;
- Data Grants, User -> Delegations and current authorization evaluation;
- Application × Model Access;
- Model Definition validation, Registry/version lifecycle and Model Admin;
- Generic Runtime/storage for ordinary Space-owned models;
- reusable Engines/Capabilities;
- model-agnostic Domain Event outbox state, Space/subscriber-scoped Webhook Endpoints, model/event subscription filters, signed Webhook delivery, retry state and endpoint-level delivery diagnostics;
- cross-Space aggregate `/me` views;
- deterministic typed physical schema planning/publication;
- runtime validation, concurrency, soft deletion, relations, governed Change History and business audit;
- Core-side Platform Admin Application × Model Access, read-only Space inspection and platform-admin audit;
- reproducible business-facing Kernel and privileged Platform Admin contracts.

Core does not own:

- external provider login/SSO sessions;
- WeChat `openid` or application-specific provider mappings;
- Cloudflare Access `(iss, sub) -> usr_*` mapping;
- LifeSpace application/service credential hashes;
- platform-administrator assignment state;
- application UI/session state;
- application-specific event-subscription configuration UX;
- arbitrary executable user/AI code or SQL in metadata.

## Metadata-driven domain rules

- Ordinary models are declared through the closed Model Definition DSL and interpreted by fixed Runtime code.
- The shipped baseline Model Definitions are edited only in `apps/core/model-catalog/baseline-models.json`. `src/builtin-models.ts`, deployment semantic projections and tests must derive from that catalog rather than maintain parallel editable definitions.
- Historical SQL migrations are immutable publication snapshots, not a second current Model Definition source. When the shipped catalog changes, add an explicit compatibility-classified convergence migration and preserve historical rows.
- Fresh-migration tests must prove the final published Registry definitions and schema hashes equal the canonical shipped catalog. Do not hard-code environment-local Registry version numbers as semantic identity when a current published version or schema hash can be used instead.
- Do not add handwritten CRUD/router/table sets for ordinary models when Model Definition + reusable Capability can represent the requirement.
- Missing behavior should be evaluated as a reusable Engine/Capability or true Kernel exception before adding source code.
- Published Model Definition versions are immutable and compatibility-classified.
- Logical metadata is authoritative; physical persistence uses deterministic generated typed model tables plus shared record/relation/capability structures.
- Physical DDL is generated only from validated metadata by fixed platform code. Never execute AI/client-provided SQL.
- Ordinary model Runtime paths stay isolated under `/api/v1/spaces/{spaceId}/models/{modelKey}/records/...`; `modelKey` is the only stable model address and must resolve from the isolate snapshot without Discovery or a D1 hot-path lookup.
- Metadata must not contain arbitrary JavaScript, SQL, shell code or unrestricted expressions.
- Ordinary model mutations participate in platform Eventing generically; do not add model-specific event names or handwritten Webhook calls for new business models.

## Runtime performance rules

- D1 Registry state is durable authority, but hot ordinary requests resolve published model metadata from the Worker-isolate runtime snapshot instead of re-reading Registry rows per request.
- Compile stable query/relation/access metadata once per runtime Registry snapshot.
- Cache stable model/runtime rules only. Memberships, Data Grants, Application × Model Access and other revocable authority remain current-state checks.
- Query/list mapping must not perform D1 I/O per result record.
- Batch shared Space/Person/Capability/relation context.
- Prefer fewer Worker↔D1 round trips; use D1 `batch()` where semantics allow it.
- Preserve budgets in `docs/runtime-storage-performance.md`.
- Do not introduce another distributed cache without measured need.

## Ordinary authorization rules

Every ordinary operation evaluates the intersection of:

```text
verified principal
∩ stable credential scope
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ explicit current Delegation when verified Principal and Actor differ
∩ published model access capability
∩ model policy / Capability restrictions
```

Rules:

- every ordinary business record has exactly one source `space_id`;
- `space_id` existence is never proof of access;
- request `userId` is never current actor identity;
- revoking membership/Grant/model access must take effect from current state;
- closed Spaces are never ordinary authorization targets, even if stale membership or Grant rows remain;
- Core normalizes verified RS256 JWTs and Identity-introspected opaque `lsp_svc_*` tokens (plus legacy `lsp_pat_*` migration tokens) into one principal context;
- service credentials still require explicit application/Data Grant/model authority;
- whole-Space Data Grants use `resource_type=space, resource_id=NULL`;
- model-collection Data Grants use `resource_type=model, resource_id=<published model key>` and authorize only Generic Runtime access to that model in the source Space;
- a model operation may use either a matching model-collection Grant or a whole-Space Grant, taking the highest current active permission; Kernel Space/membership APIs never treat a model-collection Grant as Space authority;
- Webhook Endpoint management is a user/Space-management operation: it requires `spaces:manage` and current Space `manage` permission; creating an endpoint grants no model access;
- adding/enabling/materially editing an Event Subscription filter additionally requires current managing-application read access and a current subscriber Data Grant for the selected model;
- Webhook URL and signing secret belong to the Endpoint, never to an individual model subscription;
- event delivery is reference-only and must not become a bypass around normal record-read authorization;
- no service/platform executor becomes a hidden Space member.

## Platform administration

Core platform administration is separate from ordinary Space `manage` and from the business-facing Kernel contract.

A privileged Console request requires:

```text
Authorization: Bearer <service executor>
X-LifeSpace-Actor-Token: <Identity-issued human actor proof>
```

Core verifies independently that:

- executor principal type is `service`;
- executor contains the route-specific capability (`applications:manage`, `spaces:inspect`, `audit:read`, etc.);
- actor proof is a valid LifeSpace user JWT;
- actor proof has `scope=platform:admin`;
- actor proof has `purpose=platform_admin_actor`;
- proof lifetime is at most 300 seconds;
- actor and executor `clientId`/`azp` match.

Core intentionally does **not** duplicate Identity `platform_administrators` assignment state. Identity re-checks assignment on Identity-owned admin calls and new actor-proof issuance; Core bounds assignment-revocation latency through the five-minute proof lifetime.

Read-only Space inspection must never create hidden membership or mutate Space/Grant state.

Platform-admin audit records both the human actor and service executor, bounded secret-free summary, target, request ID, result and timestamp.

## Model Admin compatibility

Model Registry administration remains service-principal-only with `models:manage`.

Existing CI/platform automation may call Model Admin without a human actor proof.

When LifeSpace Console supplies `X-LifeSpace-Actor-Token` for Model publish/retire, Core additionally validates the platform-admin context and records human + executor audit. For those Console-triggered mutations:

- initial audit row is written as `pending` before Registry mutation starts;
- if that initial audit write fails, mutation must not begin;
- successful/failed mutation attempts update the pending audit to `success`/`failure` where possible;
- audit never stores credentials or Authorization headers.

Do not make service automation depend on an interactive human solely to improve Console auditability.

## Persistence

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
current Kernel version: 0.43.0
```

Integration/Eventing public contract (same Worker, independent lifecycle):

```text
apps/core/integration-eventing.openapi.yaml
current Integration/Eventing version: 0.3.0
```

Model Registry / Model Contract governance contract:

```text
apps/core/model-control-plane.openapi.yaml
current Model Control Plane version: 0.2.0
```

Privileged LifeSpace Console control-plane contract:

```text
apps/core/platform-admin.openapi.yaml
current Platform Admin version: 0.3.0
```

Ordinary model contract:

```text
immutable Model Contract Revision: mct_<sha256>
```

Do not put Console-only privileged APIs into the Kernel contract simply because they are served by the same Worker. Do not duplicate ordinary model routes into either code-owned contract.

Console Model publish/retire profiles reuse the Model Control Plane request/response schemas; they must not become a second hand-maintained Model Definition schema.

## Consumer independence

Use prior consumer behavior only as evidence when deciding whether a semantic belongs in LifeSpace. Do not preserve consumer-specific ownership, identity, role, lifecycle, persistence, delivery, UI or product-policy assumptions unless they have been deliberately generalized as a platform invariant.

Application-specific migration/cutover tooling belongs in the consumer repository or Git history, not in current Core source.

## Verification

A Core change is incomplete until:

- applicable Kernel and Platform Admin contract checks pass;
- tests, typecheck and dry-run Worker build pass;
- migrations/schema expectations are aligned;
- metadata/runtime changes preserve Registry/contract reproducibility;
- authorization changes include positive and deny paths;
- Eventing changes cover event generation, Endpoint transport/signing, subscription filtering, retry/idempotency and revocation behavior appropriate to the slice;
- Platform Admin changes cover service-only executor, missing/wrong-purpose/mismatched actor proof and no-hidden-Space-authority behavior;
- performance-sensitive changes preserve D1 round-trip/N+1 rules;
- downstream Kernel/model-contract impact is explicitly assessed.
