# LifeSpace Contract Strategy

## Ownership

Canonical service contracts live with the service implementation in this repository.

Identity API syntax remains explicitly owned by `apps/identity/openapi.yaml`.

Core has two contract layers:

1. **Kernel Contract** — explicit, code-owned APIs such as Space, Membership, Data Grant, Registry-driven Creation Draft orchestration and model administration. The checked-in contract is `apps/core/openapi.yaml` and is versioned independently from ordinary models.
2. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.

As of Core Kernel `0.12.0`, ordinary model paths/schemas are deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects Event/Task/Day Record/Wish or generic `{modelRoute}` paths if they are reintroduced into the Kernel OpenAPI.

The effective client contract is therefore an explicit pair:

```text
Kernel Contract: 0.12.0 (or another pinned Kernel version)
Model Contract:  mct_<hash>
```

Do not create a separately hand-maintained contract repository.

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
- Data Grant lifecycle;
- Registry-driven Creation Draft orchestration;
- service-only Model Admin and immutable Model Contract reads.

The Kernel contract must never be used as a second hand-maintained description of ordinary business models. A new ordinary model must not require an edit to `apps/core/openapi.yaml`.

A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moves Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`.

## Published artifacts

`packages/contracts` is the reproducible publication/export surface for pinned Kernel + Model Contract combinations such as OpenAPI bundles, JSON Schema, TypeScript types and stable indexes. `packages/client` is the generated or thin handwritten SDK surface built against an explicit compatible combination.

Generated output must be reproducible from canonical inputs and must never become a second editable source of truth.

A repository commit is **not** required merely to make a newly published Model Definition have a contract revision. Repository publication/export is needed when an application or release wants a checked-in/package artifact for a selected revision.

Application-specific handoff artifacts are generated from an explicit integration profile rather than from the currently active/unversioned Model Contract. The exporter must verify the deployed Kernel/Identity versions, read the exact configured immutable `mct_*` revision, and include only non-secret contract/application-policy material. A service-only credential used to read the immutable revision is an export-time implementation detail and must never be written into the handoff.

The initial Phase-4 HomeMew handoff under `packages/contracts` contains the pinned Identity OpenAPI, Core Kernel OpenAPI, Model Contract OpenAPI/JSON Schema/manifest, HomeMew integration profile, a handoff manifest and SHA-256 checksums with a deterministic bundle id. The normal staging workflow uploads this generated directory as a read-only workflow artifact after the HomeMew integration and platform regression gates pass.

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

ALOHA, HomeMew and vertical apps must depend on explicit compatible contract artifacts/revisions. They must not fetch an unversioned latest model contract during normal builds.

For Coding Agents and repository-local development, an application may check in or generate a read-only snapshot containing the exact Kernel/model contract combination it consumes. Such snapshots are generated artifacts and must not be edited manually.

## Compatibility

- Published Model Definition versions are immutable.
- Model changes require explicit compatibility classification: `initial`, `compatible` or `breaking`.
- Additive compatible changes may remain on the existing runtime route only when earlier compatible clients remain valid.
- Breaking request/response or behavior changes require an approved downstream migration/versioning strategy before activation.
- Model retirement is an explicit lifecycle action and does not delete historical Model Definitions or Model Contract Revisions.
- Kernel deployment and package publication are coordinated where Kernel behavior changes, while model-only publication can create a new `mct_*` revision without a Worker code deployment.
- Planned models/endpoints/fields must be clearly distinguishable from published/active ones before clients are allowed to call them.

## Required checks

Changes to public API behavior should fail CI when Kernel inputs, Model/Capability definitions, generated contracts, implementation and selected publication artifacts drift.

Metadata-platform checks include:

- Kernel OpenAPI contains only explicit Kernel surfaces and rejects ordinary/generic model paths;
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
