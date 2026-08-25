# LifeSpace Contract Strategy

## Ownership

Canonical service contracts live with the service implementation in this repository.

Identity now has two explicit contract surfaces:

1. **Identity Application Contract** — `apps/identity/openapi.yaml`, used by ordinary user/application authentication, profile, trusted application exchange, Cloudflare Access principal linking and application-owned service authentication. Its current version remains `0.5.0`.
2. **Identity Platform Admin Contract** — `apps/identity/platform-admin.openapi.yaml`, used only by the LifeSpace Console and approved break-glass/platform-control workflows. Its initial version is `0.1.0`.

Core has three contract layers:

1. **Kernel Contract** — explicit, code-owned APIs such as Space, Membership, Data Grant, Event Subscription, Registry-driven Creation Draft orchestration and service-only model administration. The checked-in contract is `apps/core/openapi.yaml` and is versioned independently from ordinary models.
2. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged control-plane profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Its initial version is `0.1.0`.
3. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.

As of Core Kernel `0.14.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects Event/Task/Day Record/Wish or generic `{modelRoute}` paths if they are reintroduced into the Kernel OpenAPI. Kernel `0.13.0` introduced whole-Space and published-model collection Data Grant targeting; Kernel `0.14.0` adds the model-agnostic Event Subscription/Webhook control surface without duplicating ordinary-model CRUD schemas into the Kernel contract.

The effective ordinary application contract remains an explicit tuple such as:

```text
Identity Application Contract: <pinned version>
Kernel Contract:               <pinned version>
Model Contract:                mct_<hash>
```

A platform operator surface such as LifeSpace Console additionally pins the two Platform Admin companion contracts:

```text
Identity Platform Admin Contract: 0.1.0
Core Platform Admin Contract:     0.1.0
```

The control-plane split is intentional. Adding Console governance capabilities must not force HomeMew, ALOHA or another downstream business application to repin its ordinary Kernel/Identity contract when their callable business/authentication syntax did not change. Conversely, downstream applications and their Agents should not discover platform-admin capabilities merely by consuming their ordinary application contract.

Do not create a separately hand-maintained contract repository.

## Platform Admin control-plane contract

The Platform Admin contracts are first-class canonical contracts, not undocumented internal endpoints. They live beside the owning service implementation, have explicit versions, and are covered by service CI.

They are companion contracts rather than alternative service implementations: the routes execute in the same Identity/Core Workers, but their consumers, authentication requirements and compatibility lifecycle are distinct from ordinary application clients.

Normative rules:

- `apps/identity/platform-admin.openapi.yaml` and `apps/core/platform-admin.openapi.yaml` are the only editable OpenAPI sources for the new Console control plane.
- Both start at contract version `0.1.0`; the versions may advance independently later if the two services' admin syntax evolves at different rates.
- Console privileged operations use the dual identity model from `docs/permissions.md`: a controlled server-side executor plus `X-LifeSpace-Actor-Token` carrying the dedicated short-lived human actor proof.
- The actor proof is not a reusable general user credential. Identity issues it only from an ordinary authenticated LifeSpace user session after current `platform_administrators` assignment checks, and the proof is bound to `purpose=platform_admin_actor` with a maximum five-minute lifetime.
- Bootstrap administrator-assignment routes are included only as provisioning/break-glass control-plane syntax. The bootstrap secret is never a Console runtime credential.
- Core's Console Model Admin paths intentionally refer to the existing Kernel Model Admin request/response schemas rather than authoring a second Model Definition contract. The Kernel remains authoritative for Model Definition/publication syntax; the Platform Admin contract adds the human-proof/audit profile.
- Read-only User/Access-principal and Space/member/Grant inspector surfaces remain control-plane-only. They do not create ordinary user/Space permissions.
- One-time `lsa_*` and `lsp_pat_*` plaintext fields remain write-only contract data and are never returned by list/read surfaces.

A Console release should pin the ordinary contracts it needs for normal profile/session/model metadata reads plus explicit Platform Admin versions. The future `apps/console` build must not call an unversioned undocumented admin route.

## Model-driven generation

Publishing an ordinary model is sufficient to derive its standard CRUD/query/action contract surface from the Model Registry and Generic Runtime semantics.

The generator owns model-derived:

- concrete Space model collection/item paths;
- request/response schemas;
- server-default semantics;
- field constraints;
- relation identifiers;
- declared search/filter/range/sort/cursor parameters;
- lifecycle/version fields;
- workflow action paths;
- Capability-specific additions registered deterministically by the Capability.

Current Capability contributions include Temporal computed/query/occurrence/action surfaces and Calendar timed/all-day/dual-window query semantics.

AI Admin never edits OpenAPI directly. It proposes Model Definitions; normal validation/publication drives contract generation.

## Immutable Model Contract Revisions

Every successful Model Registry publish or retire operation atomically activates a concrete Model Contract Revision.

A revision contains:

- a manifest of model key, route, model version and schema hash;
- generated concrete OpenAPI paths/schemas;
- a generated JSON Schema bundle;
- immutable creator/timestamp evidence.

Its identity is content-addressed:

```text
mct_<sha256(canonical(manifest + openapi + jsonSchema))>
```

The content hash does **not** include the mutable Registry revision counter. If the active model contract later returns to exactly the same content, the same immutable `mct_*` artifact is reused. `model_contract_state.registry_revision` separately records which Registry mutation currently activates that artifact.

Registry mutation and contract activation are one D1 transaction guarded by the global Registry revision/mutation token. Core must never commit a model publication while leaving the active contract on the previous model set.

If a migrated environment has a Registry state but no active contract pointer, first contract read may initialize the matching revision. Initialization is Registry-revision guarded and cannot overwrite a concurrent publication.

## Kernel Contract

The Kernel OpenAPI is intentionally explicit and comparatively stable. It currently covers:

- health/status and authentication-facing Core principal behavior;
- Space, Membership, Space Person-facing membership operations and invitations;
- Space avatar replacement/public reads;
- Data Grant lifecycle and target syntax;
- Event Subscription lifecycle, signed Webhook test-send and delivery diagnostics;
- Registry-driven Creation Draft orchestration;
- service-only Model Admin and immutable Model Contract reads.

Kernel 0.13.0 defines these Data Grant targets:

```text
resourceType=space, resourceId=null
  whole-Space authority; may authorize Kernel Space surfaces and ordinary model fallback

resourceType=model, resourceId=<published modelKey>
  model-collection authority; only Generic Runtime operations for that model in the source Space
```

Omitting `resourceType/resourceId` when creating a Grant remains backwards compatible with the pre-0.13 whole-Space behavior. Model collection targets are Kernel syntax because they govern authorization around generated model routes; the generated model CRUD schemas themselves still belong exclusively to `mct_*`.

Kernel 0.14.0 adds Event Subscription management as model-agnostic Kernel syntax. A subscription selects a published `modelKey` and generic `record.created` / `record.updated` / `record.deleted` event types, but it does not redefine that model's records. The Webhook payload is reference-only; consumers that need full record data must use the ordinary Model Contract route under their current service credential and Data Grant authority.

The Kernel contract must never be used as a second hand-maintained description of ordinary business models. A new ordinary model must not require an edit to `apps/core/openapi.yaml`.

The Platform Admin split also means Console-only governance syntax does not automatically become downstream Kernel syntax. If a future admin capability genuinely becomes a normal application-facing Kernel feature, that transition must be explicit and versioned rather than achieved by merely pointing an application at the admin contract.

A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` adds the generic Eventing subscription and Webhook-delivery management surface.

## Published artifacts

`packages/contracts` is the reproducible publication/export surface for pinned contract combinations such as OpenAPI bundles, JSON Schema, TypeScript types and stable indexes. `packages/client` is the generated or thin handwritten SDK surface built against an explicit compatible combination.

Generated output must be reproducible from canonical inputs and must never become a second editable source of truth.

A repository commit is **not** required merely to make a newly published Model Definition have a contract revision. Repository publication/export is needed when an application or release wants a checked-in/package artifact for a selected revision.

Application-specific handoff artifacts are generated from an explicit integration profile rather than from the currently active/unversioned Model Contract. The exporter must verify the deployed Kernel/Identity versions, read the exact configured immutable `mct_*` revision, and include only non-secret contract/application-policy material. A service-only credential used to read the immutable revision is an export-time implementation detail and must never be written into the handoff.

The HomeMew handoff under `packages/contracts` contains the pinned Identity OpenAPI, Core Kernel OpenAPI, Model Contract OpenAPI/JSON Schema/manifest, HomeMew integration profile, a handoff manifest and SHA-256 checksums with a deterministic bundle id. The normal staging workflow uploads this generated directory as a read-only workflow artifact after the HomeMew integration and platform regression gates pass.

Platform Admin contracts are **not** added to the HomeMew handoff merely because they exist in the platform repository. They belong only in Console/platform-operator artifacts. This preserves least-privilege discovery and keeps the accepted HomeMew evidence independent from Console evolution.

### Historical accepted HomeMew handoff — Phase 4

Phase 4 accepted and froze this application contract tuple:

```text
Identity Contract:    0.4.0
Core Kernel Contract: 0.12.0
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted at that time
```

The exporter-enabled `Deploy staging` run #29 (`31694445585`) passed on 2026-08-13 and proved deterministic export/upload of that exact contract/application-policy combination before the publication-state flip from candidate to accepted. That tuple remains immutable historical evidence; later compatible Kernel/Identity/model pins do not rewrite what Phase 4 proved.

HomeMew and its Coding Agents must treat the Phase-2 Core `0.11.0` / Identity `0.3.0` versions as historical parity evidence only. They are not the current HomeMew client contract.

## Runtime and downstream pinning

Production Core resolves the active Model Registry at runtime. Applications do not silently consume that moving Registry as their build contract.

An application release pins, directly or through a generated package, an explicit compatible pair such as:

```text
Kernel Contract: <version>
Model Contract:  mct_<hash>
```

Pinning an old Model Contract Revision is contract evidence and a reproducible code-generation input; it is **not** a promise that arbitrary future breaking active-model changes remain runtime-compatible forever.

Therefore:

- additive compatible model versions must preserve clients built against the compatible earlier revision;
- a breaking model publication requires an explicit downstream migration/rollout strategy before activation;
- model retirement requires confirmation that dependent applications/integrations no longer rely on that model route;
- future AI Admin diff/publish gates must surface affected Application × Model access and pinned dependency evidence before destructive activation.

Where genuine simultaneous incompatible runtime versions are later required, that must be introduced deliberately through versioned routing/storage semantics rather than pretending an old contract snapshot alone provides runtime compatibility.

## Downstream applications

ALOHA, HomeMew and vertical apps must depend on explicit compatible ordinary contract artifacts/revisions. They must not fetch an unversioned latest model contract during normal builds and must not consume Platform Admin contracts unless the application is explicitly an approved platform-operator surface.

For Coding Agents and repository-local development, an application may check in or generate a read-only snapshot containing the exact Kernel/model contract combination it consumes. Such snapshots are generated artifacts and must not be edited manually.

LifeSpace Console is different: it is a platform-operator application. Its artifact set should include explicit pinned Identity/Core Platform Admin contract versions in addition to the ordinary Identity/Kernel contracts it uses for login/session/model reads.

## Compatibility

- Published Model Definition versions are immutable.
- Model changes require explicit compatibility classification: `initial`, `compatible` or `breaking`.
- Additive compatible changes may remain on the existing runtime route only when earlier compatible clients remain valid.
- Breaking request/response or behavior changes require an approved downstream migration/versioning strategy before activation.
- Model retirement is an explicit lifecycle action and does not delete historical Model Definitions or Model Contract Revisions.
- Kernel deployment and package publication are coordinated where Kernel behavior changes, while model-only publication can create a new `mct_*` revision without a Worker code deployment.
- Platform Admin contract compatibility is evaluated separately from ordinary downstream contracts; admin-only additive syntax does not itself require a Kernel/Identity application-contract version bump.
- Planned models/endpoints/fields must be clearly distinguishable from published/active ones before clients are allowed to call them.

## Required checks

Changes to public or control-plane API behavior should fail CI when canonical inputs, generated contracts, implementation and selected publication artifacts drift.

Metadata-platform checks include:

- Kernel OpenAPI contains only explicit Kernel surfaces and rejects ordinary/generic model paths;
- Identity/Core Platform Admin OpenAPI contains the implemented Console control-plane routes and explicitly requires the dual actor/executor boundary where applicable;
- Platform User/Space Inspector contracts remain read-only and do not imply ordinary authorization;
- platform-managed secret creation remains one-time/write-only and list/read contracts never expose plaintext or hashes;
- Data Grant contracts preserve whole-Space compatibility and explicitly validate model-collection target semantics;
- Eventing contract checks preserve model-agnostic event types, subscriber Service Principal binding and one-time signing-secret behavior without copying ordinary record schemas;
- Model Definition validation;
- deterministic schema hashing;
- deterministic OpenAPI/JSON Schema generation;
- server defaults remain aligned between Runtime, AI draft generation and generated contract;
- Capability contract contributions remain aligned with Capability Runtime/query semantics;
- no Kernel/model route collisions;
- no duplicate model-derived operation IDs/schema names;
- content-addressed contract snapshot reproducibility;
- atomic Registry revision + active contract mutation;
- Generic Runtime behavior matching generated constraints;
- compatibility/retirement dependency gates before production use.

HomeMew's former handwritten OpenAPI contract-check pattern remains a behavioral reference for strict drift detection, not the ordinary-model source-authoring model.
