# LifeSpace Contract Strategy

## Ownership

Canonical service contracts live with the service implementation in this repository.

Identity now has two explicit contract surfaces:

1. **Identity Application Contract** — `apps/identity/openapi.yaml`, used by ordinary user/application authentication, profile, trusted application exchange, Cloudflare Access principal linking and application-owned service authentication. Its current version is `0.6.0`; 0.6.0 adds first-class Agent identity and Core-only delegated Agent execution-token issuance.
2. **Identity Platform Admin Contract** — `apps/identity/platform-admin.openapi.yaml`, used only by the LifeSpace Console and approved break-glass/platform-control workflows. Its current version is `0.2.0`; 0.2.0 adds Application-scoped Agent identity governance while preserving the existing dual actor/executor control-plane boundary.

Core has five contract layers:

1. **Kernel Contract** — explicit application/runtime APIs such as Space, Membership, Data Grant, Runtime Discovery, Registry-driven Creation Draft orchestration and governed Change History. The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.34.0` owns neither Model Registry governance nor Eventing wire representation.
2. **Integration / Eventing Contract** — `apps/core/integration-eventing.openapi.yaml`, the independently versioned public contract for Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send and signed reference-only outbound Webhook representation. Its initial version is `0.1.0`; the same Core Worker still executes the routes.
3. **Model Control Plane Contract** — `apps/core/model-control-plane.openapi.yaml`, the independently versioned service-automation contract for Model Definition validation/publication/retirement, immutable Model Contract evidence and the optional AI-assisted proposal lifecycle. Version `0.2.0` removes the independent model route identity; every operation remains service-principal-only with `models:manage`.
4. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged Console companion profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Version `0.2.0` reuses Model Control Plane publish/retire wire schemas rather than treating Kernel as their owner.
5. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.

Core Kernel `0.34.0` adds explicit Generic Query comparison semantics to progressive static detail and generated Model Contracts. Legacy `field` / `fieldFrom` / `fieldTo` remain eq/gte/lte with inclusive `fieldTo`; new collision-free `field.operator` transport provides eq/lt/lte/gt/gte, platform envelope `createdAt` / `updatedAt` become first-class datetime comparison fields, and datetime local-date windows delegate DST-safe boundary conversion to the shared Time Semantics primitive. Schema migration 0038 adds the Space+Model-scoped updatedAt index required by the new envelope query shape.

Core Kernel `0.33.0` adds canonical structural `timeRanges` to progressive single-model semantic detail. Model-declared ranges and Calendar-derived timed/all-day ranges are projected from their authoritative semantic sources; the projection does not itself introduce overlap/interval query syntax. The Model Control Plane remains independently versioned because its `ModelDefinition` wire envelope deliberately delegates detailed DSL semantics to the normative Model Definition specification and validator. Because progressive semantic detail is a Kernel wire representation, a cache that may survive Kernel deployment must use `(Kernel contractVersion, key, version, schemaHash)` rather than treating the model semantic tuple alone as a cross-version representation identity.

As of Core Kernel `0.32.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects concrete business-model or generic Runtime paths if they are reintroduced into the Kernel OpenAPI. Kernel `0.13.0` introduced whole-Space and published-model collection Data Grant targeting; Kernel `0.14.0` introduced model-agnostic Eventing; Kernel `0.15.0` separates reusable Webhook Endpoint transport/signing from model/event subscription filters so multiple models can share one callback and signing secret. Kernel `0.16.0` adds owner-only logical Space close. Kernel `0.17.0` adds User -> Agent Delegation management and governed Change History. Kernel `0.18.0` adds cross-Space current-principal Runtime Discovery through `GET /api/v1/me/_discovery` while leaving ordinary model CRUD/action syntax in immutable `mct_*` contracts. Kernel `0.19.0` makes declared Model server defaults an explicit Runtime Discovery contract while preserving the same defaults as a Generic Runtime create invariant. Kernel `0.20.0` makes Action semantic input and optimistic-concurrency metadata mechanically distinct in Runtime Discovery while keeping the current Action wire transport compatible. Kernel `0.21.0` removes Space invitation possession bearer tokens from API URL paths and carries them only in bounded JSON request bodies for preview/join; invitation authorization, expiry, exhaustion and replay semantics are unchanged. Kernel `0.22.0` adds ordered repeatable Generic Query sort metadata and canonical human-facing field `title` metadata to Runtime Discovery while preserving stable machine field keys; generated Model Contracts project the same titles and keep relation target/cardinality metadata structurally separate. Kernel `0.23.0` adds source-field-aware Relation Target Lookup for `person` / `person_list`: callers with current source-model read authority can resolve active Space Person references as minimal `{id,label}` values without Space membership-management authority. Discovery advertises the lookup contract; lookup is not proof of create/update authority, and mutation-time Policy/relation validation remains authoritative. `record` / `record_list` lookup is explicitly unsupported until canonical record reference-label semantics are defined rather than guessed from model-specific field names. Kernel `0.24.0` adds a minimal current `spaceName` label to already-authorized Runtime Discovery Space references; the label is Context Projection, not Space-detail or membership-management authority. Kernel `0.25.0` adds bounded `capabilityBindings` for standard Capability field roles, beginning with Calendar, while preserving the existing `capabilities` inventory; the bindings are semantic Context Projection, not UI layout or mutation authority. Kernel `0.26.0` adds progressive single-model static semantic detail behind a current Space visibility gate, with an authority-independent successful body identified by `(key, version, schemaHash)` and opaque missing/invisible 404 semantics. Kernel `0.27.0` adds a compact current-principal capability inventory that de-duplicates coarse static model facts from per-Space visibility/access edges and links deterministically to the 0.26 detail surface; full Discovery remains compatible and optional. Kernel `0.28.0` adds bounded source-field-aware batch Reference Resolution for existing relation IDs: Person references resolve to minimal same-Space active Space Person labels, each valid input ID returns only `resolved` or opaque `unavailable`, input order/duplicates are preserved, and record/reference hydration remains explicitly unsupported until canonical ordinary-record label semantics exist. Kernel `0.29.0` adds model-owned canonical ordinary-record `referenceLabel` semantics, exposes them in Runtime Discovery and progressive static detail, and enables `record` / `record_list` Relation Target Lookup plus Batch Reference Resolution using that same projection. Missing/blank label input falls back to stable record ID; record lookup/resolution additionally rechecks current read authority to the target Model, and all writes still recheck mutation-time authority, Policy and relation integrity. Kernel `0.30.0` makes governed Change History an explicit record-scoped collection at `GET /api/v1/spaces/{spaceId}/changes?recordId=...` with bounded `limit` + opaque `cursor` pagination; the older `/changes/{recordId}` representation remains a deprecated Kernel 0.29 compatibility alias returning at most the latest 100 entries. Kernel `0.30.0` also removes `/model-admin/*` operations from Kernel ownership because those routes now belong to the separately versioned Model Control Plane `0.1.0` contract. Kernel `0.31.0` removes Webhook Endpoint/Event Subscription and delivery/test representation from Kernel ownership; Integration/Eventing `0.1.0` becomes their canonical public contract without moving runtime state, Queue delivery, authorization, revocation or signing out of the Core Worker. Kernel `0.32.0` makes `modelKey` the sole ordinary Runtime address, removes `route` from Definition/Registry/Discovery/Model Contract identity, and standardizes generated paths under `/models/{modelKey}/records`; the four previously deployed business paths remain explicit time-bounded compatibility aliases only.

A concrete environment/build handoff may include one immutable Model Contract Revision as exact generated API/schema evidence:

```text
Identity Application Contract: <pinned version>
Kernel Contract:               <pinned version>
Model Contract evidence:       mct_<hash>
Integration/Eventing Contract: <pinned version; only when the consumer uses Eventing>
```

That `mct_*` is not automatically the cross-environment application compatibility identity. Model Registry versions are monotonic **inside one environment**, and an `mct_*` manifest contains those environment-local versions plus the complete published Registry snapshot. Staging and production may therefore have different valid `mct_*` IDs while exposing the same application-relevant model semantics.

When an application release must be compared across environments, the stable compatibility identity must pin semantic identity rather than accidentally pinning environment-local representation. For HomeMew the accepted cross-environment release identity is:

```text
Identity Application Contract version
+ Kernel Contract version
+ Model Semantic Fingerprint
+ Integration/Eventing Contract version (for consumers such as HomeMew that use Eventing)
```

The Model Semantic Fingerprint is content-addressed over the selected application models' stable `key + schemaHash`, sorted by model key. Environment-local Model Registry `version` and the environment-wide `mct_*` revision ID are deliberately excluded. Each environment still retains its own immutable `mct_*` as exact deployment/code-generation evidence, and that environment-local contract must contain model identities matching the accepted semantic fingerprint.

A platform operator surface such as LifeSpace Console additionally pins the two Platform Admin companion contracts:

```text
Identity Platform Admin Contract: 0.2.0
Core Platform Admin Contract:     0.2.0
```

The control-plane split is intentional. Adding Console governance capabilities must not force HomeMew, ALOHA or another downstream business application to repin its ordinary Kernel/Identity contract when their callable business/authentication syntax did not change. Conversely, downstream applications and their Agents should not discover platform-admin capabilities merely by consuming their ordinary application contract.

Do not create a separately hand-maintained contract repository.

## Integration / Eventing Contract

`apps/core/integration-eventing.openapi.yaml` is the canonical public Eventing contract and starts at version `0.1.0`. It owns Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send, the signed reference-only ordinary-record change payload, `endpoint.test`, required `X-LifeSpace-*` headers, HMAC-SHA256 signature representation and at-least-once delivery semantics.

It does **not** own ordinary-model Change production, model mutation semantics or a separate authorization model. The same Core Worker remains authoritative for Endpoint/Subscription state, Application × Model Access, Data Grants, subscriber Service Principal/application eligibility, Queue delivery and current revocation. Splitting the contract lifecycle therefore does not split the runtime or create another truth source.

Runtime-only consumers omit this contract. Eventing consumers pin `Integration/Eventing 0.1.0` independently so future Eventing representation changes do not force unrelated Runtime consumers to repin Kernel, and vice versa.

## Platform Admin control-plane contract

The Platform Admin contracts are first-class canonical contracts, not undocumented internal endpoints. They live beside the owning service implementation, have explicit versions, and are covered by service CI.

They are companion contracts rather than alternative service implementations: the routes execute in the same Identity/Core Workers, but their consumers, authentication requirements and compatibility lifecycle are distinct from ordinary application clients.

Normative rules:

- `apps/identity/platform-admin.openapi.yaml` and `apps/core/platform-admin.openapi.yaml` are the only editable OpenAPI sources for the new Console control plane.
- Identity Platform Admin is `0.2.0`; Core Platform Admin is `0.2.0`. Their versions advance independently when each service's admin syntax changes.
- Console privileged operations use the dual identity model from `docs/permissions.md`: a controlled server-side executor plus `X-LifeSpace-Actor-Token` carrying the dedicated short-lived human actor proof.
- The actor proof is not a reusable general user credential. Identity issues it only from an ordinary authenticated LifeSpace user session after current `platform_administrators` assignment checks, and the proof is bound to `purpose=platform_admin_actor` with a maximum five-minute lifetime.
- Bootstrap administrator-assignment routes are included only as provisioning/break-glass control-plane syntax. The bootstrap secret is never a Console runtime credential.
- Core's Console Model Admin paths reuse the Model Control Plane request/response schemas rather than authoring a second Model Definition contract. The Model Control Plane owns governance wire syntax; the Platform Admin contract adds the human-proof/audit profile.
- Read-only User/Access-principal and Space/member/Grant inspector surfaces remain control-plane-only. They do not create ordinary user/Space permissions.
- One-time `lsa_*` and `lsp_pat_*` plaintext fields remain write-only contract data and are never returned by list/read surfaces.

A Console release should pin the ordinary contracts it needs for normal profile/session/model metadata reads plus explicit Platform Admin versions. The future `apps/console` build must not call an unversioned undocumented admin route.

## Model Control Plane contract

Model Registry governance is a first-class control plane rather than ordinary Runtime syntax. `apps/core/model-control-plane.openapi.yaml` is the canonical wire contract for service automation that validates, publishes, retires or inspects Model Definitions/Model Contract revisions. It also explicitly contracts the optional `/api/v1/model-admin/ai/proposals*` lifecycle so staging-verified production behavior cannot exist outside contract ownership.

The Model Control Plane does **not** redefine Model Definition semantics. `docs/model-definition-spec.md` plus the Core validator/Registry remain the semantic authority; the control-plane OpenAPI defines request/response representation around that authority. AI proposal generation is optional intelligence and cannot bypass normal validation, compatibility classification or publication.

Non-interactive service automation continues to authenticate as a service principal with `models:manage`. LifeSpace Console uses the same underlying Model Registry routes but adds the separate Platform Admin human actor proof and pending -> success/failure audit profile. Human actor proof is therefore an interactive governance overlay, not a new baseline requirement for CI/automation.

A model-governance consumer pins `Model Control Plane 0.2.0` independently from `Kernel 0.32.0`; an ordinary application that never administers models does not need to pin or discover the Model Control Plane.

## Model-driven generation

Publishing an ordinary model is sufficient to derive its standard CRUD/query/action contract surface from the Model Registry and Generic Runtime semantics.

The generator owns model-derived:

- concrete Space model collection/item paths;
- request/response schemas;
- server-default semantics;
- field constraints;
- relation identifiers;
- model-owned canonical ordinary-record reference-label semantics;
- declared search/filter/range/sort/cursor parameters;
- lifecycle/version fields;
- workflow action paths;
- Action semantic-input schemas plus technical mutation/concurrency annotations;
- Capability-specific additions registered deterministically by the Capability.

Current Capability contributions include Temporal computed/query/occurrence/action surfaces and Calendar timed/all-day/dual-window query semantics.

AI Admin never edits OpenAPI directly. It proposes Model Definitions; normal validation/publication drives contract generation.

## Immutable Model Contract Revisions

Every successful Model Registry publish or retire operation atomically activates a concrete Model Contract Revision.

A revision contains:

- a manifest of model key, model version and schema hash;
- generated concrete OpenAPI paths/schemas;
- a generated JSON Schema bundle;
- immutable creator/timestamp evidence.

Its identity is content-addressed:

```text
mct_<sha256(canonical(manifest + openapi + jsonSchema))>
```

The content hash does **not** include the mutable Registry revision counter. If the active model contract later returns to exactly the same content, the same immutable `mct_*` artifact is reused. `model_contract_state.registry_revision` separately records which Registry mutation currently activates that artifact.

Because the manifest includes environment-local Model Registry versions and the complete published model set, `mct_*` is exact immutable **environment contract evidence**, not by itself a promise of one globally identical revision ID across staging, production or other independently evolved registries. Stable cross-environment compatibility must be expressed using the semantic identity that actually needs to remain invariant.

Registry mutation and contract activation are one D1 transaction guarded by the global Registry revision/mutation token. Core must never commit a model publication while leaving the active contract on the previous model set.

If a migrated environment has a Registry state but no active contract pointer, first contract read may initialize the matching revision. Initialization is Registry-revision guarded and cannot overwrite a concurrent publication.

A code-owned Model Contract generator change may also change the contract bytes while the published Model Registry itself is unchanged. In that case `getOrCreateActiveModelContract()` deterministically regenerates the snapshot, preserves the current stable Registry revision, inserts/reuses the new immutable `mct_*` revision, and atomically reconciles the active pointer. Historical `mct_*` revisions remain immutable. A generator-only contract evolution therefore does not require a fake Model Definition publication or schema migration merely to refresh the active contract evidence.

## Kernel Contract

The Kernel OpenAPI is intentionally explicit and comparatively stable. It currently covers:

- health/status and authentication-facing Core principal behavior;
- single-Space and cross-Space Runtime Discovery capability previews;
- authorized source-field-aware Relation Target Lookup for generated clients;
- bounded source-field-aware Reference Resolution/Hydration for existing relation IDs;
- User -> Agent Delegation lifecycle and governed Change History;
- Space, Membership, Space Person-facing membership operations and invitations;
- Space avatar replacement/public reads;
- Data Grant lifecycle and target syntax;
- Registry-driven Creation Draft orchestration;
- governed Change History as a bounded record-scoped collection.

Model Registry administration and immutable Model Contract governance are intentionally absent from Kernel 0.32.0 and live in the Model Control Plane contract instead. Eventing representation is likewise absent from Kernel 0.32.0 and lives in Integration/Eventing 0.1.0.

Kernel 0.13.0 defines these Data Grant targets:

```text
resourceType=space, resourceId=null
  whole-Space authority; may authorize Kernel Space surfaces and ordinary model fallback

resourceType=model, resourceId=<published modelKey>
  model-collection authority; only Generic Runtime operations for that model in the source Space
```

Omitting `resourceType/resourceId` when creating a Grant remains backwards compatible with the pre-0.13 whole-Space behavior. Model collection targets are Kernel syntax because they govern authorization around generated model routes; the generated model CRUD schemas themselves still belong exclusively to `mct_*`.

Kernel 0.15.0 historically introduced the current Eventing resource semantics. Kernel 0.31.0 removes their wire representation from the Kernel contract only; the same Core Worker, authorization and delivery semantics remain authoritative and are now described by Integration/Eventing 0.1.0.

### Runtime Discovery

Runtime Discovery is a current capability projection, never an authorization proof.

```text
GET /api/v1/spaces/{spaceId}/_discovery
  -> given one known Space, return currently effective model/query/action metadata

GET /api/v1/me/_discovery
  -> across all currently reachable source Spaces, return only Spaces with at least one effective model capability

GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}
  -> use the Space only as a current visibility gate, then return static semantics for one visible model identity

GET /api/v1/me/_discovery/inventory
  -> return compact request-current Space/model visibility edges plus de-duplicated coarse model facts

POST /api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}
  -> under current source-model read authority, hydrate a bounded existing-ID list into minimal labels or opaque unavailable results
```

Both surfaces use the same live authority intersection: verified principal context, credential scope, Application × Model Access, current membership/Data Grant, current Agent Delegation when Actor is an Agent, and published model access/capability restrictions. Execution always rechecks current authorization and record/action rules, so membership, Grant or Delegation revocation takes effect on subsequent requests.

Kernel `0.19.0` additionally exposes each visible model's declared static `defaults` in the same discovery projection. These values describe server-owned create semantics: when a caller omits a field with a declared default, Generic Runtime applies and validates that default before required-field validation; an explicit caller value wins and is validated normally. Dynamic clients can therefore distinguish `required with server default` from `required and caller must supply` without hard-coded Task/Event/Wish knowledge.

Kernel `0.20.0` separates **Action semantic input（动作语义输入）** from **concurrency metadata（并发元数据）**. `action.input.fields` contains only caller-owned domain/semantic inputs. An Action with no domain input therefore exposes an empty field list even though execution still requires optimistic-concurrency evidence. Technical mutation evidence is declared separately:

```json
{
  "input": { "fields": [] },
  "concurrency": {
    "strategy": "record-version",
    "required": true,
    "transport": { "in": "body", "name": "version" }
  }
}
```

`record-version` means the caller must execute against the current common resource-envelope version and stale evidence remains a `VERSION_CONFLICT` deny path. The `transport` object tells generic clients where that evidence is carried on the current HTTP wire representation; it is not a business field and must not be rendered as ordinary Action input. A client may resolve the current record version from the normal record read surface immediately before execution, or bind an already-known current version from its own state. Future transport cleanup may move this evidence to another HTTP location without redefining the Action's semantic input.

Generated Model Contract revisions carry the same distinction. Action request schemas may still include the current body `version` for wire compatibility, but that property is marked `x-lifespace-input-role: concurrency`, and the Action operation exposes the corresponding `x-lifespace-concurrency` annotation. Runtime Discovery, generated `mct_*` evidence and execution-time stale-write protection must remain aligned.

The cross-Space response is deliberately minimal but human-readable: each already-reachable Space entry contains stable `spaceId`, the current `spaceName` label and effective model metadata. The label is a bounded Runtime Context Projection so generated clients can identify an authorized Space without a second adapter-specific lookup. It does not expose kind, timezone, membership roles, owners or members and does not grant Space-management authority. The single-Space discovery response carries the same label only while at least one effective model capability is visible; otherwise `spaceName` is `null`. Clients that need actual Space administration/detail continue to use the normal Space APIs under their separate authority.

Kernel `0.23.0` extends this projection with relation-target resolution. A relation field's stable structural semantics remain in Model Definition / generated JSON Schema (`targetModel` + cardinality); Runtime Discovery adds whether the current relation kind has a generic target lookup. For `person` / `person_list`, `GET /api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}` returns only active Space Person `{id,label}` references under the caller's current source-model read authority, with bounded search and cursor pagination. The result does not expose membership roles/global user IDs and does not establish mutation authority: create/update policies and relation integrity are rechecked when a write executes. Dynamic relation targets are therefore never serialized as static JSON Schema `enum` values.

Kernel `0.29.0` extends the same relation projection to `record` / `record_list`. Each target Model owns one canonical `referenceLabel` semantic (`field`, bounded simple `template`, or stable record-ID fallback when omitted/blank). The label is projected consistently into Runtime Discovery/static detail, Relation Target Lookup and Batch Reference Resolution. Ordinary-record lookup/resolution requires current source-model read authority **and** current target-model read authority, so a source relation never becomes a label-disclosure side channel.

Kernel `0.25.0` also exposes a bounded `capabilityBindings` object on each discovered model. `capabilities` remains the backwards-compatible inventory of enabled standard Capability names. `capabilityBindings.calendar` carries only the canonical model-field roles already declared by the published Calendar Capability mapping (all-day marker, timed start/end, timezone fields, all-day date range and optional attendee field). Generic clients may use those roles to understand mutually exclusive timed/all-day shapes without guessing Event field names. Core execution remains authoritative for Calendar validation, and the projection deliberately contains no renderer/widget/layout instructions.

Kernel `0.26.0` adds the progressive **Static Semantic Plane** at `GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}`. The Space participates only in the request-current visibility check. On success the body contains static model semantics—not Membership, Grant, Delegation or effective-access state—and is stable for the returned `(key, version, schemaHash)`. Missing and currently non-discoverable models intentionally use the same opaque 404 so semantic-detail lookup does not become a model-existence side channel. Every actual CRUD/query/Action still rechecks current authority.

Kernel `0.27.0` adds the compact **Dynamic Visibility Plane** at `GET /api/v1/me/_discovery/inventory`. It uses the same live authority intersection as aggregate Discovery, but materializes coarse static model identity/display/Capability/Action facts only once and represents each reachable Space as minimal `modelKey + effective access` edges. Heavy fields/defaults/query/action-input/Capability-binding semantics are deliberately omitted and loaded only when needed through the deterministic 0.26 semantic-detail path template. This prevents `S × M` duplication from becoming the default Agent/LLM context while preserving the existing full Discovery surfaces for compatible consumers. Cached positive inventory is never execution authority.

The Kernel contract must never be used as a second hand-maintained description of ordinary business models. A new ordinary model must not require an edit to `apps/core/openapi.yaml`.

The Platform Admin split also means Console-only governance syntax does not automatically become downstream Kernel syntax. If a future admin capability genuinely becomes a normal application-facing Kernel feature, that transition must be explicit and versioned rather than achieved by merely pointing an application at the admin contract.

A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` introduced generic Eventing; Kernel `0.15.0` separates shared Webhook Endpoint transport/signing from model/event subscription filters; Kernel `0.16.0` adds owner-only logical Space close; Kernel `0.17.0` adds Agent Delegation/governed Change; Kernel `0.18.0` adds cross-Space current-principal Runtime Discovery; Kernel `0.19.0` exposes authoritative Model server defaults through Runtime Discovery while keeping default application in Generic Runtime semantics; Kernel `0.20.0` separates Action semantic input from optimistic-concurrency metadata without changing the current body-based concurrency transport; Kernel `0.21.0` moves Space invitation bearer tokens from URL paths to JSON request bodies as a Candidate/Public security migration without changing invitation lifecycle semantics; Kernel `0.22.0` adds ordered multi-field Generic Query sorting and Agent-readable canonical field titles across Runtime Discovery and generated model contracts; Kernel `0.23.0` adds source-field-aware Person Relation Target Lookup; Kernel `0.24.0` adds minimal current `spaceName` Context Projection; Kernel `0.25.0` adds bounded standard Capability field-role bindings; Kernel `0.26.0` adds progressive single-model static semantic detail; Kernel `0.27.0` adds the compact current capability inventory.

## Published artifacts

`packages/contracts` is the reproducible publication/export surface for pinned contract combinations such as OpenAPI bundles, JSON Schema, TypeScript types and stable indexes. `packages/client` is the generated or thin handwritten SDK surface built against an explicit compatible combination.

Generated output must be reproducible from canonical inputs and must never become a second editable source of truth.

A repository commit is **not** required merely to make a newly published Model Definition have a contract revision. Repository publication/export is needed when an application or release wants a checked-in/package artifact for a selected revision.

Application-specific handoff artifacts are generated from an explicit integration profile rather than from an unversioned latest Model Contract. For a cross-environment release profile, the profile pins the application-relevant semantic identity; the exporter then reads an explicit immutable environment-local `mct_*` evidence revision and proves that its selected model identities match that semantic fingerprint before exporting generated OpenAPI/JSON Schema. A service-only credential used to read the immutable revision is an export-time implementation detail and must never be written into the handoff.

The HomeMew handoff under `packages/contracts` contains the pinned Identity OpenAPI, Core Kernel OpenAPI, one staging Model Contract OpenAPI/JSON Schema/manifest as immutable code-generation evidence, HomeMew integration profile, a handoff manifest and SHA-256 checksums with a deterministic bundle id. The handoff manifest identifies the cross-environment Model Semantic Fingerprint separately from the environment-local `mct_*` evidence ID. The normal staging workflow uploads this generated directory as a read-only workflow artifact after the HomeMew integration and platform regression gates pass.

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

Production Core resolves the active Model Registry at runtime. Applications do not silently consume that moving Registry as their build or release compatibility contract.

A concrete generated client/handoff may pin an immutable environment contract revision as a reproducible build input:

```text
Kernel Contract:        <version>
Model Contract evidence: mct_<hash>
```

For a release that must move across independently evolved environments, compatibility is instead pinned to the stable application-relevant semantics, for example:

```text
Identity Contract:          <version>
Kernel Contract:            <version>
Model Semantic Fingerprint: msf_<hash>
```

The target environment must then prove that its own active immutable `mct_*` contains the selected models with exactly that semantic identity. Equality with another environment's `mct_*` is required only if the release deliberately defines global Registry/version identity as part of its contract; it is not the default assumption.

Pinning an old Model Contract Revision is contract evidence and a reproducible code-generation input; it is **not** a promise that arbitrary future breaking active-model changes remain runtime-compatible forever.

Therefore:

- additive compatible model versions must preserve clients built against the compatible earlier revision;
- a semantic fingerprint change for an application-consumed model requires an explicit downstream compatibility decision before production promotion;
- a breaking model publication requires an explicit downstream migration/rollout strategy before activation;
- model retirement requires confirmation that dependent applications/integrations no longer rely on that model;
- future AI Admin diff/publish gates must surface affected Application × Model access and pinned dependency evidence before destructive activation.

Where genuine simultaneous incompatible runtime versions are later required, that must be introduced deliberately through versioned routing/storage semantics rather than pretending an old contract snapshot alone provides runtime compatibility.

## Downstream applications

ALOHA, HomeMew and vertical apps must depend on explicit compatible ordinary contract artifacts/semantic release identities. They must not fetch an unversioned latest model contract during normal builds and must not consume Platform Admin contracts unless the application is explicitly an approved platform-operator surface.

For Coding Agents and repository-local development, an application may check in or generate a read-only snapshot containing the exact Kernel/model contract evidence it consumes. Such snapshots are generated artifacts and must not be edited manually.

LifeSpace Console is different: it is a platform-operator application. Its artifact set should include explicit pinned Identity/Core Platform Admin contract versions in addition to the ordinary Identity/Kernel contracts it uses for login/session/model reads.

## Compatibility

- Published Model Definition versions are immutable.
- Model changes require explicit compatibility classification: `initial`, `compatible` or `breaking`.
- Additive compatible changes may remain on the stable modelKey-addressed Runtime surface only when earlier compatible clients remain valid.
- Breaking request/response or behavior changes require an approved downstream migration/versioning strategy before activation.
- Model retirement is an explicit lifecycle action and does not delete historical Model Definitions or Model Contract Revisions.
- Kernel deployment and package publication are coordinated where Kernel behavior changes, while model-only publication can create a new `mct_*` revision without a Worker code deployment.
- A deterministic Model Contract generator change may reconcile a new active immutable `mct_*` revision against the same stable Registry revision; this is contract evolution, not a reason to synthesize a fake model publication.
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
- Runtime Discovery checks preserve current authority intersection, preview-only semantics, Agent Delegation narrowing, authoritative Model defaults, Action semantic-input/concurrency separation, progressive static-detail opacity, compact inventory de-duplication/boundedness and the cross-Space no-detail-leak boundary;
- Eventing contract checks preserve model-agnostic event types, Endpoint/subscriber binding, shared one-time signing-secret behavior, model/event filter separation and reference-only payloads without copying ordinary record schemas;
- Model Definition validation;
- deterministic schema hashing;
- deterministic OpenAPI/JSON Schema generation;
- server defaults remain aligned between Runtime, AI draft generation, Runtime Discovery and generated model contract;
- Action request schemas/annotations remain aligned with Runtime Discovery concurrency metadata and execution-time stale-write protection;
- Capability contract contributions remain aligned with Capability Runtime/query semantics;
- canonical modelKey Runtime paths remain isolated under `/models/{modelKey}/records`;
- no duplicate model-derived operation IDs/schema names;
- content-addressed contract snapshot reproducibility;
- atomic Registry revision + active contract mutation;
- application semantic fingerprint reproducibility and target-environment semantic compatibility where a cross-environment release identity is declared;
- Generic Runtime behavior matching generated constraints;
- compatibility/retirement dependency gates before production use.

HomeMew's former handwritten OpenAPI contract-check pattern remains a behavioral reference for strict drift detection, not the ordinary-model source-authoring model.

### Agent-ready contract split — 0.6.0 / 0.17.0

Identity Application Contract `0.6.0` owns Agent identity (`agt_*`) and trusted-application issuance of short-lived `purpose=delegated_agent` execution JWTs whose audience is Core only. Core Kernel `0.17.0` owns User -> Agent Delegation current state, Delegation-bounded Runtime Discovery/authorization and governed Change History. Identity does not read Core Delegations; a valid Agent JWT is therefore necessary but never sufficient authority. Core rechecks the mutable Delegation and all existing authorization layers at execution time. Existing accepted downstream tuples remain pinned evidence and must not be silently rewritten merely because the platform publishes a newer compatible contract.
