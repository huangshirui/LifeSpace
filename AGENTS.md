# LifeSpace Agent Instructions

LifeSpace is the platform for giving any Space a durable Shared Reality and governed action foundation. External applications are replaceable consumers of the platform and are not the boundary of the platform itself. LifeSpace is the sole source of truth for global LifeSpace user identity, Space/Data Grant authorization, shared domain models, platform migrations, contracts and deployment configuration.

## Read before making changes

Read in this order:

1. `docs/north-star.md` for the evolving long-term direction, foundational assumptions, core axioms and architecture decision lens;
2. `docs/architecture.md` for the current target architecture and normative boundaries;
3. `docs/permissions.md`;
4. `docs/application-authentication.md` for Web/Access/application identity work;
5. `docs/service-authentication.md` for service, Agent, automation, device or machine credentials;
6. `docs/contracts.md`;
7. `docs/authority-role-capability-redelegation.md` for the accepted Entity Role Capability, Agent-as-Principal and bounded re-delegation target architecture;
8. `docs/agent-ready.md` for Principal / Actor / Delegation / governed Change rules and the distinction between current released profiles and accepted target behavior;
9. `docs/model-definition-spec.md` for the normative human-readable Model Definition / Policy / Workflow / Capability DSL semantics;
10. `docs/model-platform-architecture.md` for business-model/runtime architecture;
11. `docs/runtime-storage-performance.md` for ordinary-model storage, Registry runtime lookup, query hydration, authorization I/O or performance-sensitive paths;
12. `docs/generic-consumer-contract.md` when changing discovery, semantic projection, reference resolution or consumer-facing genericity;
13. `apps/AGENTS.md` and the nearest nested `AGENTS.md` for every directory changed;
14. relevant OpenAPI contracts, tests, migrations, implementation, Model Definitions and generated artifacts.

If a required source does not yet exist during initial scaffold, create/update it before implementing behavior that depends on it.

## Sources of truth

- Evolving long-term direction/architecture lens: `docs/north-star.md`
- Current platform boundaries/topology: `docs/architecture.md`
- Space ownership, Grants, principals and effective authorization: `docs/permissions.md`
- Application/Cloudflare Access identity: `docs/application-authentication.md`
- Service/machine credential policy: `docs/service-authentication.md`
- Contract ownership/versioning/publication/downstream consumption: `docs/contracts.md`
- Accepted Entity Role Capability, Agent Principal and bounded re-delegation target architecture: `docs/authority-role-capability-redelegation.md`
- Agent execution-context, Delegation and governed Change invariants, including current released-profile boundaries: `docs/agent-ready.md`
- Model Definition / Policy / Workflow / Capability DSL semantics: `docs/model-definition-spec.md`
- Metadata business-model architecture: `docs/model-platform-architecture.md`
- Runtime performance/typed persistence: `docs/runtime-storage-performance.md`
- Generic consumer projection/authority boundary: `docs/generic-consumer-contract.md`
- Core business-facing Kernel API: `apps/core/openapi.yaml`
- Core Integration/Eventing API: `apps/core/integration-eventing.openapi.yaml`
- Core Model Registry / Model Contract governance API: `apps/core/model-control-plane.openapi.yaml`
- Core privileged Platform Admin API: `apps/core/platform-admin.openapi.yaml`
- Identity application/user/service API: `apps/identity/openapi.yaml`
- Identity privileged Platform Admin API: `apps/identity/platform-admin.openapi.yaml`
- Ordinary business-model semantics/contracts: validated Model Definitions / Model Registry / immutable `mct_*` revisions
- Database history: service-owned migrations
- Verified behavior: automated tests
- Implementation details: source code

The North Star is directional rather than a claim of already-implemented behavior. Current architecture/contracts/tests remain authoritative for what exists now. Do not silently reconcile disagreements between these sources. Preserve deployed behavior unless the task explicitly changes the contract/boundary.

## Long-term architecture lens

The North Star is built on five foundational assumptions and five core axioms. Do not promote a replaceable product, model, Agent framework, protocol or storage choice above them.

Core axioms:

1. **Space Boundary** — durable Shared Reality exists in an explicit Space; Spaces are isolated by default and cross-Space sharing is explicit, bounded and revocable.
2. **Durable Shared Reality** — LifeSpace persists the World and Knowledge that should survive replacement of the current App, Agent or protocol.
3. **Bounded Authority** — every participant acts only through explicit authority; entity type and operation role are distinct, and Principal and Actor must remain distinguishable when they differ.
4. **Governed Change** — durable Shared Reality changes only through authorized, semantically valid Change with risk controls appropriate to the operation.
5. **Federated Truth** — LifeSpace does not own all truth; external information is deliberately Own/Mirror/Reference/Query.

For a platform-level abstraction, persistent state, public contract, protocol dependency or cross-cutting capability, first identify the durable concept and the replaceable implementation around it.

Classify the change primarily as one or more of:

- **Shared World** — durable domain entity, relationship, state, occurrence, plan or commitment inside Shared Reality;
- **Shared Knowledge** — durable rule, preference, assertion, observation, assessment or derived knowledge worth sharing across authorized applications/Agents;
- **Authority** — identity, permission, grant, delegation, consent or approval;
- **Change** — intent, action, proposal, validation, commit, compensation or change history;
- **Semantics** — model/schema/capability/constraint/policy mechanism defining the above;
- **Context Projection** — authorized/relevant runtime projection of Shared Reality;
- **Adapter** — protocol/external-system/transport integration;
- **Experience** — application or UI behavior for a particular audience.

Keep entity type and operation role orthogonal. Conceptually, `User`, `Agent`, `Application` and `Service` are identifiable entity types/capabilities, not children of a universal `Principal` ontology. In a particular operation:

```text
principal          = whose authority is exercised
actor              = who/what executes or initiates the operation
applicationContext = through which application context it occurs
```

Current contracts and implementation may still use established terms such as authenticated `principal` or `service principal`; do not rename deployed vocabulary casually. But future design must not erase the Principal/Actor distinction merely because implementation uses `principal` as an authentication label.

Before committing to a platform design, ask:

1. Which foundational assumption and North Star axiom justify this abstraction?
2. Are we modeling durable Shared World/Knowledge, or merely today's application/UI/Agent context?
3. Does durable state belong to a Space, or are we accidentally making an application its owner?
4. Would the concept still make sense if the current application disappeared?
5. Would it still make sense if the current Agent framework, AI model, protocol or orchestration product disappeared?
6. Is MCP/REST/OpenAI tooling/workflow automation/another protocol being treated as an adapter rather than domain truth?
7. Are AI-derived observations/claims distinguishable from authoritative state where that distinction matters?
8. For delegated/autonomous action, are Principal, Actor, application context, delegation and source correctly attributed?
9. Is CRUD merely the transport for a more durable semantic Action/Change concept?
10. Does durable external information belong under Own, Mirror, Reference or Query?
11. Is a proposed Kernel rule genuinely universal, or is it a personal/family/organization/application assumption?
12. Are we prematurely generalizing a temporary implementation rather than preserving a clean extension point?

LifeSpace should be Agent-ready but AI-independent. Applications, Agents, models, protocols and orchestration systems are replaceable layers. Durable Shared Reality, Authority, Change and their required semantics/history must not depend on one of them.

Do not silently redefine LifeSpace through a local feature implementation. If a requested change conflicts with `docs/north-star.md`, surface the conflict and preserve the current boundary unless the architectural direction is deliberately revised. The North Star itself may evolve when new evidence changes the long-term problem framing; such changes must be explicit and recorded rather than incidental.

## Mandatory platform rules

### Identity and operation roles

- LifeSpace user identity is global: one natural person has one platform `usr_*` across applications and Spaces.
- `User`, `Agent`, `Application` and `Service` are conceptually entity types/capabilities; `principal` and `actor` are operation roles. Do not assume `Principal -> User | Agent | Application | Service` is the long-term ontology.
- Principal means whose authority is being exercised for an operation; Actor means who/what actually executes or initiates it. They may be equal or different.
- An Agent may be a first-class Actor and, if explicitly granted independent authority, may also be a Principal. It never inherits a user's authority merely by being the Actor.
- Application-specific external identities are not LifeSpace identities. WeChat `openid`, WeCom IDs, school-provider IDs and similar subjects remain mappings owned by the application adapter/BFF.
- Cloudflare Access platform principals are the deliberate shared-Web exception: Identity owns verified `(iss, sub) -> usr_*` mapping and account linking.
- Access `aud` identifies the protected application context and must be registered to the intended LifeSpace application; it is not part of the user key.
- Access email/display claims are non-authoritative and must never silently merge accounts.
- Unknown Access principals require explicit create-new-account or proof-backed link-existing-account flow.
- A trusted application backend may assert an already-resolved `usr_*` only with its own revocable `lsa_*`; Identity derives `azp`, scope ceiling and token TTL from current registered application state.
- Never trust browser/Mini Program input containing arbitrary `userId`, Access `sub`, email or decoded claims as authentication authority.
- Identity remains a LifeSpace credential/identity service, not a parallel Google/Microsoft/email IdP while Cloudflare Access remains the approved Web SSO layer.

### Space and data authorization

- Space is the ownership/default authorization boundary for ordinary business data and the primary durable Shared Reality boundary in the long-term platform model; it is not synonymous with personal, family, organization, tenant or workspace.
- Spaces are isolated by default. Cross-Space sharing must remain explicit, bounded and revocable and must not merge the Spaces.
- Do not encode personal/family/organization/application-specific Space rules into the Kernel unless they are deliberately generalized as universal invariants.
- Every ordinary business record belongs to exactly one source Space.
- Sharing never changes ownership or creates a second authoritative copy; use Data Grants/approved derived views.
- Data authorization and application authorization are independent.
- Effective ordinary-model permission is the intersection of verified authenticated identity/principal context, credential scope, Application × Model Access, current Space membership/Data Grant, published model capability and model policy/Capability restrictions.
- The authenticated actor/identity context comes from verified credentials, never request `userId`.
- Core owns current Space/Grant/model authorization. UI/BFF control hiding is usability only, never the security boundary.
- Cross-Space aggregate `/api/v1/me/...` is a Core capability; clients should not be forced to rediscover/merge every Space themselves.

### Metadata-driven models

- Ordinary business models are metadata-driven. Adding one must not require a handwritten CRUD router/service/table set.
- New source code should normally represent reusable Kernel, Runtime, Engine, Capability or deterministic physical-schema concerns.
- If the DSL lacks a requirement, decide/document whether it belongs in a reusable Capability/Engine or is a genuine Kernel exception before implementing.
- Metadata-driven logical schema does not imply universal JSON persistence. Ordinary scalar fields use deterministic generated typed model tables after performance convergence; common identity/audit/relations/Capability projections remain reusable platform structures.
- Physical DDL is generated by fixed platform code from validated Model Definitions. AI/client input must never provide arbitrary SQL.
- Model metadata must never contain arbitrary JavaScript, SQL, shell or unrestricted executable expressions.
- Published Registry rows remain durable authority, but hot ordinary requests use the Worker-isolate Runtime Model Descriptor snapshot instead of re-reading/re-validating Registry rows each request.
- Do not perform per-record D1 I/O during list/query mapping; batch shared relation/person/Space/Capability context.
- Mutable authorization state such as memberships, Data Grants and Application × Model Access remains current-state and must not be hidden behind long-lived metadata cache.

### Platform administration

- LifeSpace platform administration is separate from Space roles and ordinary business permissions.
- Cloudflare Access controls entry to owner-controlled Console/Admin Web applications but does not itself grant LifeSpace platform-admin authority.
- Identity owns explicit `platform_administrators` assignments.
- Privileged interactive Console operations require **both**:
  - a dedicated <=5-minute signed human proof with `purpose=platform_admin_actor`, `scope=platform:admin`, and Console `azp`;
  - a server-only operation-specific controlled executor credential belonging to the same LifeSpace application context.
- Identity-owned admin uses Console `lsa_*` executor; Core-owned admin uses a service principal executor.
- Raw `actorUserId`, email, Access `sub`, decoded JWT fields or unsigned headers are never accepted as operator authority.
- The bootstrap secret remains provisioning/break-glass authority only and must not become normal Console runtime configuration.
- No platform executor becomes a hidden member of every Space or receives broad data Grants merely to operate the control plane.
- Platform-admin audit must distinguish human Actor from backend/service executor and never persist credential plaintext/hashes/Authorization headers.
- Existing non-interactive service automation such as service-only Model Admin remains supported where explicitly designed; Console-triggered privileged mutations add actor-aware audit rather than forcing all automation to become interactive.

## Identity and browser security

- Unified Identity does not mean a shared parent-domain browser cookie.
- Never use `Domain=aisr.online` to share authentication authority across applications.
- Owner-controlled Web/PWA/Admin/internal tools should use Cloudflare Access as the preferred long-term Web authentication/SSO layer within the same Zero Trust organization.
- Applications unrelated to LifeSpace may use Access without LifeSpace Identity. LifeSpace-dependent Web apps use same-origin BFF -> verified Access assertion -> Identity exchange -> Core.
- BFFs must not create a second Access-subject -> `usr_*` database or business-data source of truth.
- Core does not use a browser-wide ambient cookie as its primary authentication mechanism.
- Browser JavaScript/Mini Program/downloadable clients must never receive `lsa_*`, `lsp_pat_*`, bootstrap secrets or signing keys.
- CORS is not authorization. If direct browser-to-Core access exists, use exact Origin allowlists and still enforce all credential/app/data/model checks.

## Service/authentication rules

- Owner-controlled trusted services may use opaque, individually scoped, revocable `lsp_pat_*` Service API Tokens.
- OAuth `client_credentials` remains available for third-party/policy-controlled services; it is not mandatory for every owner-controlled integration.
- `lsa_*` authenticates a trusted application backend to Identity; `lsp_pat_*`/service JWT authenticates a service identity/principal context to Core. Do not conflate them.
- Service/device identities receive only explicit credential scopes, Application × Model Access and Data Grants.
- Permanent personal-user API tokens are not a service-authentication substitute.
- An Agent acting on behalf of a user must preserve delegated user authority and Actor attribution; a permanent service administrator is not a substitute for user delegation.

## Contract workflow

LifeSpace intentionally separates product/runtime contracts from privileged control-plane contracts.

Current code-owned contract layers:

```text
Identity application/user/service:
  apps/identity/openapi.yaml

Identity Platform Admin:
  apps/identity/platform-admin.openapi.yaml

Core Kernel:
  apps/core/openapi.yaml

Core Integration / Eventing:
  apps/core/integration-eventing.openapi.yaml
  independently versioned public companion contract; same Core Worker, separate compatibility lifecycle

Core Model Control Plane:
  apps/core/model-control-plane.openapi.yaml

Core Platform Admin:
  apps/core/platform-admin.openapi.yaml

Ordinary models:
  immutable generated mct_<sha256> Model Contract Revision
```

Do not add Console-only privileged APIs to the product-facing Identity/Core contracts solely because the same Worker serves them. Conversely, do not implement privileged endpoints outside the Platform Admin companion contracts/checks.

For public behavior changes:

1. update the contract/Model/Capability definition that owns the behavior;
2. update architecture/permissions/auth docs when boundaries change;
3. update implementation;
4. update migrations/physical schema planning as appropriate;
5. add positive + deny-path tests and contract checks;
6. regenerate reproducible generated artifacts rather than hand-editing model-derived surfaces;
7. record compatibility and downstream impact.

Applications consume explicit compatible contract versions/revisions; they must not silently track an unversioned latest contract.

## Adding an ordinary business model

Before publishing an ordinary domain model define through Model Definition/registered Capabilities:

- source Space and subject/person semantics;
- supported authenticated identities/operation actors and access capabilities;
- read/write/manage and sensitive-data policy;
- cross-Space Grant behavior;
- field/time/date semantics;
- indexes/query/search/aggregate needs;
- lifecycle/deletion/concurrency;
- reusable Capabilities;
- actions/workflows/computed fields;
- notification/webhook/AI interpretation participation where enabled;
- contract/downstream impact.

Do not create one-off domain source code merely because the DSL needs extension.

## Repository discipline

- Keep platform code, contracts, Kernel/Identity migrations and deployment configuration in this repository.
- Keep product UI and application-specific external-provider mappings in application repos, except the LifeSpace platform Console itself, which belongs in this platform repo.
- Cloudflare Access principal mapping is Identity state and belongs here, not in individual application repos.
- Do not copy consumer-application behavior mechanically; preserve only semantics that have been deliberately adopted as platform policy.
- Do not make current application, AI-provider, Agent-framework, orchestration or protocol concepts durable platform truth unless the underlying abstraction remains meaningful without that dependency.
- Do not introduce packages without a concrete consumer/near-term role.
- Generated artifacts are reproducible outputs and must not be hand-edited.
- Production/staging resources and credentials remain isolated.
- Never commit credentials, JWT private keys, OAuth secrets, Cloudflare tokens, application/service secrets, provider IDs or user data.

## Problem discovery and durable tracking

GitHub Issues are the durable engineering backlog for discovered repository problems that may need to survive the current chat, branch or work session.

- Every newly discovered bug, architecture drift, security risk, contract mismatch, flaky test, technical debt item or unresolved boundary problem must be recorded in a GitHub Issue **before it is fixed, deferred or the conversation moves on**, unless an existing Issue already represents the same problem.
- Search existing open Issues first. Update the existing Issue instead of creating a duplicate when the finding shares the same root cause or decision.
- If a new finding is only a different symptom of the current Issue, append the evidence there. If it has an independent root cause, risk, decision or completion condition, create a separate Issue so another conversation can resume it without hidden context.
- Record enough durable context to resume later: observed/current behavior, evidence or relevant paths, impact/risk, whether the proposed fix is decided or still under review, and a concrete next step or acceptance condition when known.
- Do not leave a discovered problem only in chat history, a PR review/comment, source TODO, local notes or the Notion architecture decision log. Those may reference the Issue, but they do not replace it.
- The Notion `99 · 架构演进与决策日志` records decisions after architectural/product/engineering conclusions are made; GitHub Issues record unresolved problems and follow-up work before the decision or implementation is complete.
- Close an Issue only after the problem is actually resolved and the relevant merged/verified evidence exists, or after an explicit decision that no change is required with the rationale recorded on the Issue.

## Change completion

Before declaring a platform change complete, inspect all coupled surfaces: North Star assumptions/axioms, Identity, Access/application auth, Principal/Actor attribution, platform-admin actor/executor state, Space/Grant rules, Application × Model Access, Registry, runtime descriptor cache, physical schema, Generic Runtime, Capabilities, all applicable contract layers, migrations, tests, SDK/client generation, docs, infrastructure and downstream compatibility.

For platform-level work, explicitly state whether the durable abstraction belongs to Shared World, Shared Knowledge, Authority or Change; whether supporting work is Semantics/Context Projection/Adapter/Experience; and which North Star axiom it serves. Fix drift in the same change or record an explicit approved follow-up while keeping unsupported behavior unavailable.