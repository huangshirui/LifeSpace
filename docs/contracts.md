# LifeSpace Contract Strategy

## External Model + Connection companions / 外部模型与连接契约

`apps/core/external-connection.openapi.yaml` 0.4.0 owns the product setup and binding-lifecycle flow shared by Console and downstream applications: Space-scoped Provider discovery, Dynamic Connection lifecycle, Provider Resource discovery, bindable External Model Definition discovery, Definition × Connection × Resource binding, binding list/access-disable management, stored latest-schema inspection and schema refresh. Stored schema inspection is configuration-only: it reads the latest Core snapshot without a Provider call and never substitutes for runtime Space Discovery or business execution authority. It requires direct User `spaces:manage` plus current Space `manage`; Core generates the opaque `cnx_*` reference and clients never submit or read `credentialRef`. Provider selection is deployment-routed by `providerKey` to provider-specific private Service Bindings and transport secrets, while Core cursor signing uses an independent `EXTERNAL_CURSOR_SECRET`. `apps/core/external-connection-adapter.contract.json` version 1 owns the authenticated private Adapter management contract. Provider credential plaintext is transient and credential persistence is Adapter-owned per-Connection Durable Object state encrypted at rest with AES-256-GCM. There is no deployment-managed/static provider credential provisioning API in parallel with this path.

`apps/core/external-model.openapi.yaml` 0.5.0 owns provider-neutral External model binding/runtime representation and reuses the same LifeSpace Canonical Field Language as Native models, while `apps/core/external-adapter.contract.json` version 1 owns authenticated internal Adapter execution. Kernel 0.52.0 owns the Native/External Discovery union and business-definition binding identity. External registration is Space-local and provider-authoritative: only the latest compatible snapshot exists, with schemaHash/observedAt and honest execution capability downgrade. External business definitions use Registry/mct for stable business semantics only; Provider schema snapshots have no immutable history and external records have no Native versions. Native Model Contract generation, existing stable representations and runtime auth semantics remain unchanged. External bindings require an existing Dynamic Connection; `/api/v1/model-admin/external-sources`, Space `/external-sources`, caller-provided `sourceId` and deployment-managed credential references are retired.

## Identity 0.16.0 — self-only trusted Application inspection

Identity 0.16.0 adds `GET /internal/v1/applications/self`: a trusted server-only `lsa_*` credential may inspect only its own active Application's non-secret metadata. The route takes no target Application ID and cannot modify credentials/scopes or create an administrative actor. This removes one unnecessary privileged Bootstrap read from Staging acceptance while keeping human Platform Admin dual-authorization and Bootstrap recovery separate. Production availability requires a successful exact-candidate production deployment; this text defines mainline contract intent rather than claiming 0.16.0 is deployed.

## Identity 0.15.0 — globally unique login mailbox

Identity Schema 14 adds a user-owned, globally unique login email reservation independent of Access principals and Applications. Email declaration/change/unlink requires a LifeSpace user bearer and optimistic revision; registered Access JWT verification may complete a reserved mailbox's principal association, while email-only claims not reserved by any user grant nothing. Unrelated Access principals and the global `usr_*` remain active on mailbox changes. Legacy ambiguous email metadata is not silently merged; conflicts are audited for reconciliation. The compatible `GET/PATCH /api/v1/me/web-login` contract gains DELETE and `EMAIL_ALREADY_LINKED` 409.

## Identity 0.11.0 / Platform Admin 0.5.0 — client-agnostic Application subject

Identity `0.11.0` removes the obsolete Application `clientType` classification. `Application` remains the stable registered application access subject while Web, Mini Program, PWA, BFF, Worker and deployment topology stay inside the owning product. One Application may hold multiple independently rotatable/revocable `lsa_*` trusted-backend credentials without creating additional Application identities. Cloudflare Access audiences bind protected entry points to active trusted Applications and no longer imply a `web` Application type. Platform Admin `0.5.0` removes the same client classification from Application administration while preserving the existing dual human-actor/executor boundary and the Agent credential governance introduced in `0.4.0`.

## Identity 0.10.0 / Platform Admin 0.4.0 — first-class Agent API credential

Identity 0.10.0 adds revocable opaque `lsp_agt_*` Agent API credentials bound to Application + Agent Actor. Credential possession grants no Space/model/User Authority: direct execution remains `Principal=Agent / Actor=Agent`, while represented execution requires an explicit current `dlg_*` and resolves only `Principal=User / Actor=Agent`. Platform Admin 0.4.0 adds create/list/reduce/revoke governance for the same credential lifecycle; one-time plaintext remains write-only. Canonical Service API Tokens remain `lsp_svc_*`, with legacy `lsp_pat_*` accepted only as migration input until rotate/revoke.

## Kernel 0.49.0 — configuration-time model semantic discovery

Kernel 0.49.0 adds authenticated Application/credential-scoped model inventory and semantic-detail discovery under `/api/v1/me/_discovery/models*`. Configuration eligibility is bounded by credential `resources:*` scopes, current Application × Model Access and published model capability, but deliberately does not require Space Membership, Data Grant or Delegation. This lets generic consumers bind a future `spc_*` target and model before data Authority exists; every concrete Runtime operation still rechecks the complete current Authority intersection.

## Kernel 0.43.0 — Atomic multi-Delegation issuance

Kernel 0.43.0 adds `POST /api/v1/spaces/{spaceId}/delegations/batch` for one confirmed business intent that must materialize 1..20 independent Delegations atomically. The operation reuses the generalized Root/Child Delegation primitive, validates all requested Authority/chain narrowing before one all-or-none commit, preserves one immutable scope per `dlg_*`, and never consumes a single-use parent merely by issuing a Child.


## Ownership

Canonical service contracts live with the service implementation in this repository.

Identity now has two explicit contract surfaces:

1. **Identity Application Contract** — `apps/identity/openapi.yaml`, used by ordinary user/application authentication, profile, trusted application exchange, Cloudflare Access principal linking, service authentication and application-owned Agent authentication. Its candidate version is `0.16.0` (Production currently remains at 0.15.0 until deployed); 0.16.0 adds self-only trusted Application inspection, while 0.11.0 previously removed obsolete Application client classification and 0.10.0 introduced first-class `lsp_agt_*` Agent API credentials.
2. **Identity Platform Admin Contract** — `apps/identity/platform-admin.openapi.yaml`, used only by the LifeSpace Console and approved break-glass/platform-control workflows. Its current version is `0.5.0`; 0.5.0 removes `clientType` from Application administration while retaining the Agent API credential governance and dual actor/executor control-plane boundary introduced in 0.4.0.

Core has six contract layers:

1. **Kernel Contract** — explicit application/runtime APIs such as Space, Membership, Data Grant, Runtime Discovery and governed Change History. The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.49.0` separates configuration-time model semantic discovery from Space data Authority while preserving execution-time authorization. Kernel `0.44.0` adds first-class opaque Agent API credential authentication on top of the generalized Authority v3 Root/Child Delegation model and bounded atomic `1..20` multi-Delegation issuance. Every resulting `dlg_*` remains an independent immutable single-scope Delegation; all requested current Principal Authority and parent-chain narrowing checks complete before one all-or-none D1 commit, and Child issuance does not consume a single-use parent. First-class Generic Runtime resource Batch remains ordinary-model syntax projected through immutable Model Contracts rather than the Kernel. Production availability remains separately tracked under `docs/production/*`.
Kernel `0.39.0` completes the explicit breaking removal of deprecated `Space.kind` from Space create/read and invitation-preview representations and migration 0045 removes the storage column. Kernel 0.38.0 had already removed every behavioral dependency on the field and made create-time `kind` optional/deprecated. There is no replacement Kernel field because business classification is not a platform semantic. The Stable `core-space-membership` group remains Stable; after the recorded deprecation and breaking-removal decision, the accepted Stable schema evidence is deliberately regenerated for the 0.39.0 representation rather than downgrading maturity or silently refreshing evidence to bypass compatibility review.

2. **Integration / Eventing Contract** — `apps/core/integration-eventing.openapi.yaml`, the independently versioned public contract for Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send and signed reference-only outbound Webhook representation. Current version `0.3.0` preserves the ordinary reference-only `recordChange` webhook and adds `changeSetCommitted`: one explicit atomic Runtime Batch keeps N governed Changes / N Domain Event references but is transported as one signed callback envelope per eligible Webhook Endpoint. Unrelated changes are never time-window coalesced; the same Core Worker still executes the routes.
3. **External Connection Contract** — `apps/core/external-connection.openapi.yaml` 0.4.0, independently versioned Space-scoped product configuration for provider-routed discovery, Dynamic Connection create/list/update/revoke, Provider Resource discovery, bindable External business definition discovery, binding create/list/access-disable lifecycle, stored latest-schema inspection and schema refresh. The schema-inspection read is local/configuration-only and does not grant Runtime model/data access. It uses ordinary direct-User Space management rather than Platform Admin authority; creating a Connection itself grants no Membership, Data Grant, Application × Model Access or binding. This is the only Provider credential provisioning contract.
4. **Model Control Plane Contract** — `apps/core/model-control-plane.openapi.yaml`, the independently versioned service-automation contract for Model Definition validation/publication/retirement, immutable Model Contract evidence and the optional AI-assisted proposal lifecycle. Version `0.2.0` removes the independent model route identity; every operation remains service-principal-only with `models:manage`.
5. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged Console companion profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Version `0.3.0` removes the retired Space kind filter/representation from the privileged inspector while preserving the platform-admin authority boundary.
6. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.

Current first-class Batch Model Contract semantics allow update/delete items to omit `version`. A supplied version is the caller's explicit optimistic-concurrency expectation; when omitted, Core resolves the current version from the same bounded set-wise target snapshot already required by Batch preparation and still commits conditionally on that version. This is a compatible input relaxation for existing Batch callers and does not move ordinary Batch syntax into the Kernel OpenAPI.

Core Kernel `0.37.0` adds the canonical Model Definition temporal vocabulary needed by Runtime Discovery and generated contracts: new definitions may use `instant`, `range<date>` and `range<instant>`. Existing published `datetime` fields remain a compatibility spelling and keep their immutable model-definition/schema-hash identity; new publication cannot introduce that legacy spelling. Top-level `timeRanges` is likewise retained only for already-published structural compatibility, while new range-valued state uses a first-class Range field. This release does not perform the separately gated Event -> TemporalRange migration and does not define ordinary fixed-Range sorting.

Core Kernel `0.37.0` also evolves Calendar Capability bindings to make one `temporal_range` field the canonical Calendar time truth. Runtime Discovery and progressive static semantic detail expose Calendar binding as a canonical `{ rangeField, attendeePersonField? }` shape while retaining the prior split-field binding only for historical published Model Definitions. Canonical Calendar models use the normal Canonical Query surface over the bound TemporalRange field; legacy `calendar.window` and split-field GET transport remain compatibility behavior only for historical definitions. Event v6 is the first shipped model using this representation.

Core Kernel `0.35.0` adds the preferred grouped `calendar.window` viewing-window semantic query to progressive static detail and generated Model Contracts. Callers provide concrete `windowStartDate` / `windowEndDateExclusive` plus explicit `viewingTimezone`; Core reuses the shared DST-safe Time Semantics conversion for timed overlap, keeps all-day overlap date-based, and defines mixed Calendar ordering in viewing-timezone semantics. The prior `rangeStart` / `rangeEnd` / `dateStart` / `dateEndExclusive` transport remains compatibility syntax and is not mixed with the preferred group. No recurrence/free-busy behavior is introduced.

Core Kernel `0.34.0` adds explicit Generic Query comparison semantics to progressive static detail and generated Model Contracts. Legacy `field` / `fieldFrom` / `fieldTo` remain eq/gte/lte with inclusive `fieldTo`; new collision-free `field.operator` transport provides eq/lt/lte/gt/gte, platform envelope `createdAt` / `updatedAt` become first-class datetime comparison fields, and datetime local-date windows delegate DST-safe boundary conversion to the shared Time Semantics primitive. Schema migration 0038 adds the Space+Model-scoped updatedAt index required by the new envelope query shape.

Core Kernel `0.33.0` adds canonical structural `timeRanges` to progressive single-model semantic detail. Model-declared ranges and Calendar-derived timed/all-day ranges are projected from their authoritative semantic sources; the projection does not itself introduce overlap/interval query syntax. The Model Control Plane remains independently versioned because its `ModelDefinition` wire envelope deliberately delegates detailed DSL semantics to the normative Model Definition specification and validator. Because progressive semantic detail is a Kernel wire representation, a cache that may survive Kernel deployment must use `(Kernel contractVersion, key, version,schemaHash)` rather than treating the model semantic tuple alone as a cross-version representation identity.

As of Core Kernel `0.32.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects concrete business-model or generic Runtime paths if they are reintroduced into the Kernel OpenAPI. Kernel `0.13.0` introduced whole-Space and published-model collection Data Grant targeting; Kernel `0.14.0` introduced model-agnostic Eventing; Kernel `0.15.0` separates reusable Webhook Endpoint transport/signing from model/event subscription filters so multiple models can share one callback and signing secret. Kernel `0.16.0` adds owner-only logical Space close. Kernel `0.17.0` adds User -> Agent Delegation management and governed Change History. Kernel `0.18.0` adds cross-Space current-principal Runtime Discovery through `GET /api/v1/me/_discovery` while leaving ordinary model CRUD/action syntax in immutable `mct_*` contracts. Kernel `0.19.0` makes declared Model server defaults an explicit Runtime Discovery contract while preserving the same defaults as a Generic Runtime create invariant. Kernel `0.20.0` makes Action semantic input and optimistic-concurrency metadata mechanically distinct in Runtime Discovery while keeping the current Action wire transport compatible. Kernel `0.21.0` removes Space invitation possession bearer tokens from API URL paths and carries them only in bounded JSON request bodies for preview/join; invitation authorization, expiry, exhaustion and replay semantics are unchanged. Kernel `0.22.0` adds ordered repeatable Generic Query sort metadata and canonical human-facing field `title` metadata to Runtime Discovery while preserving stable machine field keys; generated Model Contracts project the same titles and keep relation target/cardinality metadata structurally separate. Kernel `0.23.0` adds source-field-aware Relation Target Lookup for `person` / `person_list`: callers with current source-model read authority can resolve active Space Person references as minimal `{id,label}` values without Space membership-management authority. Discovery advertises the lookup contract; lookup is not proof of create/update authority, and mutation-time Policy/relation validation remains authoritative. `record` / `record_list` lookup is explicitly unsupported until canonical record reference-label semantics are defined rather than guessed from model-specific field names. Kernel `0.24.0` adds a minimal current `spaceName` label to already-authorized Runtime Discovery Space references; the label is Context Projection, not Space-detail or membership-management authority. Kernel `0.25.0` adds bounded `capabilityBindings` for standard Capability field roles, beginning with Calendar, while preserving the existing `capabilities` inventory; the bindings are semantic Context Projection, not UI layout or mutation authority. Kernel `0.26.0` adds progressive single-model static semantic detail behind a current Space visibility gate, with an authority-independent successful body identified by `(key, version,schemaHash)` and opaque missing/invisible 404 semantics. Kernel `0.27.0` adds a compact current-principal capability inventory that de-duplicates coarse static model facts from per-Space visibility/access edges and links deterministically to the 0.26 detail surface; full Discovery remains compatible and optional. Kernel `0.28.0` adds bounded source-field-aware batch Reference Resolution for existing relation IDs: Person references resolve to minimal same-Space active Space Person labels, each valid input ID returns only `resolved` or opaque `unavailable` results, input order/duplicates are preserved, and record/reference hydration remains explicitly unsupported until canonical ordinary-record label semantics exists. Kernel `0.29.0` adds model-owned canonical ordinary-record `referenceLabel` semantics, exposes them in Runtime Discovery and progressive static detail, and enables `record` / `record_list` Relation Target Lookup plus Batch Reference Resolution using that same projection. Missing/blank label input falls back to stable record ID; record lookup/resolution additionally rechecks current read authority to the target Model, and all writes still recheck mutation-time authority, Policy and relation integrity. Kernel `0.30.0` makes governed Change History an explicit record-scoped collection at `GET /api/v1/spaces/{spaceId}/changes?recordId=...` with bounded `limit` + opaque `cursor` pagination; the older `/changes/{recordId}` representation remains a deprecated Kernel 0.29 compatibility alias returning at most the latest 100 entries. Kernel `0.30.0` also removes `/model-admin/*` operations from Kernel ownership because those routes now belong to the separately versioned Model Control Plane `0.1.0` contract. Kernel `0.31.0` removes Webhook Endpoint/Event Subscription and delivery/test representation from Kernel ownership; Integration/Eventing `0.1.0` becomes their canonical public contract without moving runtime state, Queue delivery, authorization, revocation or signing out of the Core Worker. Kernel `0.32.0` makes `modelKey` the sole ordinary Runtime address, removes `route` from Definition/Registry/Discovery/Model Contract identity, and standardizes generated paths under `/models/{modelKey}/records`; the four previously deployed business paths remain explicit time-bounded compatibility aliases only.

A concrete environment/build handoff may include one immutable Model Contract Revision as exact generated API/schema evidence:

```text
Identity Application Contract:  <pinned version>
Kernel Contract:                <pinned version>
Model Contract evidence:        mct_<hash>
Integration/Eventing Contract:  <pinned version; only when the consumer uses Eventing>
External Connection Contract:   <pinned version; only when the consumer configures External providers>
```

That `mct_*` is not automatically the cross-environment application compatibility identity. Model Registry versions are monotonic **inside one environment**, and an `mct_*` manifest contains those environment-local versions plus the complete published Registry snapshot. Staging and production may therefore have different valid `mct_*` IDs while exposing the same application-relevant model semantics.

When an application release must be compared across environments, the stable compatibility identity must pin semantic identity rather than accidentally pinning environment-local representation. A downstream consumer should pin:

```text
Identity Application Contract version
+ Kernel Contract version
+ Model Semantic Fingerprint
+ Integration/Eventing Contract version when that consumer uses Eventing
+ External Connection Contract version when that consumer configures External providers
```

The Model Semantic Fingerprint is content-addressed over the selected application models' stable `key + schemaHash`, sorted by model key. Environment-local Model Registry `version` and the environment-wide `mct_*` revision ID are deliberately excluded. Each environment still retains its own immutable `mct_*` as exact deployment/code-generation evidence, and that environment-local contract must contain model identities matching the accepted semantic fingerprint.

A platform operator surface such as LifeSpace Console additionally pins the two Platform Admin companion contracts:

```text
Identity Platform Admin Contract: 0.5.0
Core Platform Admin Contract:     0.3.0
```

The control-plane split is intentional. Adding Console governance capabilities must not force downstream business applications to repin their ordinary Kernel/Identity contract when callable business/authentication syntax did not change. Conversely, downstream applications and their Agents should not discover platform-admin capabilities merely by consuming their ordinary application contract.

Do not create a separately hand-maintained contract repository.

## Integration / Eventing Contract

`apps/core/integration-eventing.openapi.yaml` is the canonical public Eventing contract and is currently version `0.3.0`. It owns Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send, the signed reference-only ordinary-record change payload, `endpoint.test`, required `X-LifeSpace-*` headers, HMAC-SHA256 signature representation and at-least-once delivery semantics.

It does **not** own ordinary-model Change production, model mutation semantics or a separate authorization model. The same Core Worker remains authoritative for Endpoint/Subscription state, Application × Model Access, Data Grants, subscriber Service Principal/application eligibility, Queue delivery and current revocation. Splitting the contract lifecycle therefore does not split the runtime or create another truth source.

Runtime-only consumers omit this contract. Eventing consumers pin `Integration/Eventing 0.4.0` independently so future Eventing representation changes do not force unrelated Runtime consumers to repin Kernel, and vice versa.

## External Connection Contract

`apps/core/external-connection.openapi.yaml` 0.4.0 is the canonical public setup/lifecycle contract for a product that lets a Space manager connect provider-authoritative data. It is intentionally separate from both the business-facing Kernel and privileged Model Control Plane. Console is the first proving client; ALOHA, HomeMew and future applications may implement the same journey directly.

The contract owns Provider capability descriptors, Dynamic Connection CRUD, bounded Provider Resource discovery, bindable published External business definitions, binding create/reactivation, binding list, local latest-schema inspection, read/write ceiling update, disable and schema refresh. Local schema inspection is protected by the same direct-User Space-management boundary, reads the stored snapshot without Provider I/O, and is not runtime execution authority; runtime clients continue to use Space Discovery. Connection setup requires direct User `spaces:manage` plus current Space `manage`; delegated Actors cannot configure it. The client supplies Provider credential material only on create/rotation, never a credential reference. Core generates `cnx_*`, stores only secret-free metadata/opaque reference, and routes by `providerKey` to a provider-specific private Adapter; that Adapter owns per-Connection encrypted credential persistence. A Connection alone grants no Runtime/Application/Data Authority. Connection and Definition access are both hard ceilings over binding write capability; Connection downgrade also narrows attached write bindings in D1.

The independently versioned private `apps/core/external-connection-adapter.contract.json` defines Core→Adapter management calls. It is not application-callable. Provider-specific Service Bindings/transport secrets and Adapter vault keys are deployment-owned; Core cursor HMAC uses a separate `EXTERNAL_CURSOR_SECRET`. Static/deployment-managed Provider credential maps and Source-provisioning routes are deliberately absent; test/staging tokens are inputs to this same public Dynamic Connection flow, not a second credential system.

## Platform Admin control-plane contract

The Platform Admin contracts are first-class canonical contracts, not undocumented internal endpoints. They live beside the owning service implementation, have explicit versions, and are covered by service CI.

They are companion contracts rather than alternative service implementations: the routes execute in the same Identity/Core Workers, but their consumers, authentication requirements and compatibility lifecycle are distinct from ordinary application clients.

Normative rules:

- `apps/identity/platform-admin.openapi.yaml` and `apps/core/platform-admin.openapi.yaml` are the only editable OpenAPI sources for the new Console control plane.
- Identity Platform Admin is `0.5.0`; Core Platform Admin is `0.3.0`. Their versions advance independently when each service's admin syntax changes.
- Console privileged operations use the dual identity model from `docs/permissions.md`: a controlled server-side executor plus `X-LifeSpace-Actor-Token` carrying the dedicated short-lived human actor proof.
- The actor proof is not a reusable general user credential. Identity issues it only from an ordinary authenticated LifeSpace user session after current `platform_administrators` assignment checks, and the proof is bound to `purpose=platform_admin_actor` with a maximum five-minute lifetime.
- Bootstrap administrator-assignment routes are included only as provisioning/break-glass control-plane syntax. The bootstrap secret is never a Console runtime credential.
- Core's Console Model Admin paths reuse the Model Control Plane request/response schemas rather than authoring a second Model Definition contract. The Model Control Plane owns governance wire syntax; the Platform Admin contract adds the human-proof/audit profile.
- Read-only User/Access-principal and Space/member/Grant inspector surfaces remain control-plane-only. They do not create ordinary user/Space permissions.
- One-time `lsa_*`, `lsp_svc_*` and `lsp_agt_*` plaintext fields remain write-only contract data; legacy `lsp_pat_*` is accepted input only and are never returned by list/read surfaces.

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

Both surfaces use the same live authority intersection: verified Execution Context, credential scope, Application × Model Access, Principal current membership/Data Grant, the explicitly selected current Delegation when Principal and Actor differ, and published model access/capability restrictions. Execution always rechecks current authorization and record/action rules, so membership, Grant or Delegation revocation takes effect on subsequent requests.

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

Kernel `0.26.0` adds the progressive **Static Semantic Plane** at `GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}`. The Space participates only in the request-current visibility check. On success the body contains static model semantics—not Membership, Grant, Delegation or effective-access state—and is stable for the returned `(key, version,schemaHash)`. Missing and currently non-discoverable models intentionally use the same opaque 404 so semantic-detail lookup does not become a model-existence side channel. Every actual CRUD/query/Action still rechecks current authority.

Kernel `0.27.0` adds the compact **Dynamic Visibility Plane** at `GET /api/v1/me/_discovery/inventory`. It uses the same live authority intersection as aggregate Discovery, but materializes coarse static model identity/display/Capability/Action facts only once and represents each reachable Space as minimal `modelKey + effective access` edges. Heavy fields/defaults/query/action-input/Capability-binding semantics are deliberately omitted and loaded only when needed through the deterministic 0.26 semantic-detail path template. This prevents `S × M` duplication from becoming the default Agent/LLM context while preserving the existing full Discovery surfaces for compatible consumers. Cached positive inventory is never execution authority.

The Kernel contract must never be used as a second hand-maintained description of ordinary business models. A new ordinary model must not require an edit to `apps/core/openapi.yaml`.

The Platform Admin split also means Console-only governance syntax does not automatically become downstream Kernel syntax. If a future admin capability genuinely becomes a normal application-facing Kernel feature, that transition must be explicit and versioned rather than achieved by merely pointing an application at the admin contract.

A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` introduced generic Eventing; Kernel `0.15.0` separates shared Webhook Endpoint transport/signing from model/event subscription filters; Kernel `0.16.0` adds owner-only logical Space close; Kernel `0.17.0` adds Agent Delegation/governed Change; Kernel `0.18.0` adds cross-Space current-principal Runtime Discovery; Kernel `0.19.0` exposes authoritative Model server defaults through Runtime Discovery while keeping default application in Generic Runtime semantics; Kernel `0.20.0` separates Action semantic input from optimistic-concurrency metadata without changing the current body-based concurrency transport; Kernel `0.21.0` moves Space invitation bearer tokens from URL paths to JSON request bodies as a Candidate/Public security migration without changing invitation lifecycle semantics; Kernel `0.22.0` adds ordered multi-field Generic Query sorting and Agent-readable canonical field titles across Runtime Discovery and generated model contracts; Kernel `0.23.0` adds source-field-aware Person Relation Target Lookup; Kernel `0.24.0` adds minimal current `spaceName` Context Projection; Kernel `0.25.0` adds bounded standard Capability field-role bindings; Kernel `0.26.0` adds progressive single-model static semantic detail; Kernel `0.27.0` adds the compact current capability inventory.

## Contract publication and downstream ownership

Canonical platform contracts are owned by the service OpenAPI files and immutable Model Contract revisions listed above. LifeSpace publishes platform contract identity and reproducible model-contract evidence; it does not maintain consumer-specific integration profiles, handoff bundles or release pins in this repository.

A downstream application may generate or check in its own SDK/types/snapshot from an explicit compatible LifeSpace contract version or immutable `mct_*` evidence. That generated artifact belongs to the consumer repository and must not become a second editable source of truth.

Consumer compatibility acceptance is one-way: applications decide when to adopt a LifeSpace release. A consumer pin or release milestone never blocks a compatible LifeSpace platform release.

## Runtime and downstream pinning

Production Core resolves the active Model Registry at runtime. Applications do not silently consume that moving Registry as their build or release compatibility contract.

A concrete generated client/handoff may pin an immutable environment contract revision as a reproducible build input:

```text
Kernel Contract:         <version>
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

Downstream applications must depend on explicit compatible ordinary contract artifacts/semantic release identities. They must not fetch an unversioned latest model contract during normal builds and must not consume Platform Admin contracts unless the application is explicitly an approved platform-operator surface.

For Coding Agents and repository-local development, an application may check in or generate a read-only snapshot containing the exact Kernel/model contract evidence it consumes. Such snapshots are generated artifacts and must not be edited manually.

LifeSpace Console is different: it is a platform-operator application. Its artifact set should include explicit pinned Identity/Core Platform Admin contract versions in addition to the ordinary Identity/Kernel contracts it uses for login/session/model reads. Its Space-scoped External Data setup UX nevertheless consumes the same External Connection public contract as ordinary applications rather than privileged Platform Admin syntax.

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

Changes to public or control-plane API behavior should fail CI when canonical inputs, generated contracts, implementation and selected publication artifacts drift. Stable Public code-owned OpenAPI additionally passes a schema-aware backward-compatibility comparison against generated accepted evidence; this is intentionally narrower than the full OpenAPI sanity checks and does not apply Stable representation rules to Candidate/Experimental surfaces.

Metadata-platform checks include:

- Kernel OpenAPI contains only explicit Kernel surfaces and rejects ordinary/generic model paths;
- External Connection OpenAPI contains only the Space-scoped Dynamic Connection product setup surface, never returns `credentialRef`/Provider plaintext, and rejects any parallel static/deployment-managed Provider credential provisioning surface;
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


### Agent-ready contract split — 0.6.0 / 0.17.0

Identity Application Contract `0.6.0` owns Agent identity (`agt_*`) and trusted-application issuance of short-lived `purpose=delegated_agent` execution JWTs whose audience is Core only. Core Kernel `0.17.0` owns User -> Agent Delegation current state, Delegation-bounded Runtime Discovery/authorization and governed Change History. Identity does not read Core Delegations; a valid Agent JWT is therefore necessary but never sufficient authority. Core rechecks the mutable Delegation and all existing authorization layers at execution time. Existing accepted downstream tuples remain pinned evidence and must not be silently rewritten merely because the platform publishes a newer compatible contract.


## Canonical Query discovery authority

Runtime Discovery `query.canonical` and each immutable generated Model Contract expose the same metadata-derived Canonical Query descriptor: invocation, searchable fields, typed filter targets/operators, ordered sort, pagination limits and opaque cursor bindings. Consumers must use that descriptor instead of selecting between Generic/Standard and Capability Query modes.

The remaining GET parameter and Capability Query fields in Runtime Discovery are deprecated compatibility metadata. They may guide migration of an existing caller, but they are no longer an independent semantic authority.

- Kernel 0.45.0 adds transport-independent `arq_*` Authorization Request lifecycle endpoints. Request creation is non-authorizing; the trusted adapter/workflow supplies `principalUserId` as identity context (never as Authority or an LLM argument), Confirm/Deny bind the decision to that same User, and Confirm reuses atomic Delegation issuance with current Authority checks. No separate User Proof/token exchange is introduced.
- Kernel 0.46.0 adds first-class non-atomic ordinary-model Bulk mutation through generated Model Contracts. `/models/bulk` is a bounded 1..20 transport/performance grouping with independent per-item results and `blk_*` correlation; existing `/models/batch` remains atomic `cgs_*` ChangeSet semantics.

## Kernel 0.50.0 / Semantic Relation contribution（开发中）

Kernel discovery gains governed outgoing predicates and explicit Native-only relation execution capabilities. Relation CRUD/query and the extended unified Batch belong to generated immutable Model Contracts. One canonical generator applies the contribution before hashing on both publication and active reconciliation. Batch adds relation_create/relation_delete, clientRef and atomicConsistency; omitted atomicConsistency preserves existing atomic Batch behavior, false returns independent item results. Existing models/bulk remains compatible. Full request/response/error schemas and hydration fields are projected mechanically. External endpoints and cross-store atomicity are not advertised. Production documentation remains tied to actual deployed SHAs.


## Kernel 0.51.0 / Identity 0.12.0 / Recurrence（开发中）

Kernel semantic Discovery adds recurrence_rule and Person/Record entity_ref field types, their closed valueSchema and Recurrence capability bindings. The canonical immutable Model Contract generator projects full value schemas, conditional creation requirements, Recurrence role metadata and the generated Task skip Action. Task baseline convergence is additive (subject/immutable read-only occurrence identity/skip Action); prior immutable revisions remain available. Strict generated clients should pin a compatible new Kernel/Model revision and handle new structured types. Identity 0.12.0 adds only the internal set-wise recurrence-roots status/scope projection. Deployment and production consumer pins are not advanced by this development change. See [recurrence.md](./recurrence.md).

### Kernel 0.53.0 · File / Upload Capability

Native `file` / `file_list` values are stable `fil_*` identities whose bytes remain outside ordinary typed Record storage. File transfer uses bounded `upl_*` sessions and short-lived R2 signed URLs. External `file_ref_list` keeps Provider-owned reference semantics; an External field may separately advertise upload capability while remaining unavailable to ordinary Record mutation. Consumers must never persist upload/download URLs as File identity.
## Explicit Web mailbox authorization amendment (2026-10-25)

Identity 0.13 adds an authenticated user's explicit Application-scoped mailbox login authorization. This is a deliberate Authority grant, not a verified contact field or implicit account merge. Access still verifies the actual Web identity. Existing principal conflicts are denied. See docs/application-authentication.md for scope, revocation, API and rollout rules. In development; not deployed to Production.
## 2026-10-26 correction: unified Access links

The Identity 0.14/schema 13 account-link contract supersedes the earlier 0.13 mailbox-grant wording. Both entry points write `access_principals`; pending declarations grant no token and ordinary login resolves verified issuer/subject only. GET settings projects code-linked and email-prelinked state uniformly. See `application-authentication.md`. Not deployed by this correction.
