# LifeSpace Agent Instructions

LifeSpace is the shared life-data platform behind ALOHA, HomeMew, and future vertical applications. It is the sole source of truth for global LifeSpace user identities, Space/Grant authorization, shared business-domain models, migrations, API contracts, and platform deployment configuration.

## Read before making changes

Read these files in order:

1. `docs/architecture.md`
2. `docs/permissions.md`
3. `docs/service-authentication.md` when changing service, Agent, automation, device, or machine credentials
4. `docs/contracts.md`
5. `docs/phase3-metadata-platform-plan.md` when changing business-model/runtime architecture
6. `docs/phase3-performance-convergence-plan.md` when changing ordinary-model storage, Registry runtime lookup, query hydration, authorization I/O, or performance-sensitive Core paths
7. `docs/migration-plan.md` when changing or moving behavior from HomeMew
8. The nearest nested `AGENTS.md` for every directory being changed
9. Relevant OpenAPI, tests, migrations, implementation, Model Definitions and generated artifacts

If a referenced file has not been created yet during the initial scaffold, create or update it before implementing behavior that depends on it.

## Sources of truth

- Platform boundaries and runtime topology: `docs/architecture.md`
- Space ownership, Data Grant semantics, roles, principals, model authorization and effective authorization: `docs/permissions.md`
- Service, Agent, automation, and machine credential policy: `docs/service-authentication.md`
- Contract ownership, generation, versioning, publication, and downstream consumption: `docs/contracts.md`
- Metadata-driven business-model architecture and implementation order: `docs/phase3-metadata-platform-plan.md`
- Metadata runtime performance, physical-storage convergence, Registry caching and D1 round-trip budgets: `docs/phase3-performance-convergence-plan.md`
- Core Kernel API syntax plus reproducible generated model contract surface: `apps/core/openapi.yaml`
- Identity API syntax: `apps/identity/openapi.yaml`
- Published model semantics: validated Model Definitions / Model Registry
- Database history: migrations owned by the service that owns the database
- Verified runtime behavior: automated tests
- Implementation details: source code

Do not silently reconcile disagreements between these sources. Preserve deployed behavior unless the task explicitly changes the contract. Phase 3 explicitly permits breaking the Phase-2 handwritten business-domain runtime and the intermediate Phase-3 JSON physical representation before HomeMew cutover; Kernel/security behavior remains protected unless separately approved.

## Mandatory platform rules

- LifeSpace user identity is global. A human user has one platform `user_id` regardless of which applications or Spaces they use.
- Application-specific external identities are not LifeSpace identities. WeChat `openid`, WeCom `userid`, school-platform IDs, and similar provider identifiers are resolved and mapped by the owning application adapter/BFF, not by Core and not by the generic LifeSpace Identity service.
- A trusted application backend may assert an already-resolved LifeSpace `user_id` to Identity only with its own revocable application credential. Identity must derive the calling application from that credential and constrain issued scopes to the application's registered maximum scopes.
- Never trust a browser, Mini Program, or other untrusted client to submit an arbitrary `user_id` for token issuance. External-provider credentials and mapping data stay in the owning application boundary.
- A Space is the ownership and default authorization boundary for business data. Every ordinary business record belongs to exactly one source Space.
- Sharing never changes data ownership and must not create a second source-of-truth copy. Cross-user and cross-Space visibility is expressed through Data Grants or approved derived views.
- Data authorization and application authorization are independent. Effective permission is the intersection of the principal's current data authorization, calling application/credential authorization and published model policy.
- The authenticated actor comes from verified credentials. Never trust a client-provided `userId` as the current actor.
- Core owns Space/Grant authorization, Model Registry, Generic Resource Runtime, reusable business capabilities and business authorization. Clients and BFFs may hide controls for usability but are never the security authority.
- Identity owns LifeSpace users, trusted application/client registration and credentials, LifeSpace principal resolution, short-lived token issuance/revocation, service principal and opaque Service API Token lifecycle, and signing-key lifecycle. Identity must not become a general-purpose Web SSO/IdP platform or an integration hub for every application's external login provider.
- Owner-controlled Web, PWA, Admin and internal-tool applications should use Cloudflare Access as the preferred Web authentication and SSO layer when they are protected within the same Cloudflare Zero Trust organization. An Access global session may avoid re-authentication across applications, but each application keeps its own Access policy and authorization boundary.
- Applications unrelated to LifeSpace may use Cloudflare Access SSO without depending on LifeSpace Identity. When a Web application does need LifeSpace data, its trusted BFF resolves the verified Access identity to a LifeSpace `user_id` and then uses LifeSpace credentials; Cloudflare Access does not replace LifeSpace principal resolution.
- Keep `Data Grant` terminology distinct from OAuth authorization grants or consent records.
- ALOHA, HomeMew, and vertical applications are clients of the platform. Do not add application-specific business rules to Core merely because one current client needs a particular UI flow.
- Keep Core a modular monolith unless a separately approved architecture decision justifies splitting a runtime service.
- Ordinary business models are metadata-driven. Adding an ordinary model must not require a new handwritten CRUD router/service/table set. New source code should normally represent a reusable Kernel, Runtime, Engine, Capability or deterministic schema-planning concern.
- Metadata-driven logical schema does not imply a universal JSON physical store. During Phase 3 performance convergence, ordinary scalar fields are materialized into deterministic generated typed model tables while common record identity/audit, relations and Capability projections remain reusable platform structures.
- Generic/shared storage is allowed only behind a published, validated Model Definition and fixed Generic Runtime. Never expose an arbitrary schemaless JSON store as a platform API.
- Ordinary model physical DDL must be generated by fixed platform code from validated metadata; AI/client input may propose definitions but must never supply or execute arbitrary SQL.
- Published model Registry rows remain durable authority, but normal hot-cache business requests must use the Worker-isolate Runtime Model Descriptor snapshot. Do not re-read and re-validate the same Registry row on every ordinary request.
- List/query response mapping must not perform per-record D1 I/O. Batch shared relation/person/Space/Capability context and follow the D1 round-trip budgets in `docs/phase3-performance-convergence-plan.md`.
- Mutable authorization state such as membership, Data Grants and Application × Model Access must remain current-state checks; do not trade immediate revocation for a long-lived metadata cache.
- Model metadata must never contain arbitrary JavaScript, SQL, shell code or unrestricted executable expressions. AI may propose Model Definitions but publication always flows through the same validator, compatibility checks and audit trail.
- Identity, Application, credentials, Space, Membership, Space Person, Data Grant, Model Registry administration and signing/security state are Kernel concepts, not user-defined ordinary models.
- Cross-Space aggregate queries such as `/api/v1/me/...` are a Core capability. Do not force every client to rediscover and merge all accessible Spaces itself.

## Identity and browser security

- Unified Identity does not mean a shared parent-domain browser cookie.
- Do not use `Domain=aisr.online` or another parent-domain session cookie to share sessions between applications.
- For owner-controlled Web, PWA, Admin and internal-tool applications, prefer Cloudflare Access for authentication and cross-application Web SSO rather than implementing a parallel LifeSpace browser SSO system.
- Cloudflare Access and LifeSpace Identity have different responsibilities: Access proves the Web user and enforces perimeter/application-entry policy; LifeSpace Identity resolves that trusted external identity to the LifeSpace principal and issues LifeSpace credentials when LifeSpace access is required.
- Individual Web applications may maintain their own host-only App Session through a same-origin BFF. Do not infer LifeSpace authorization from an Access session alone.
- Web applications should prefer browser -> same-origin BFF -> service binding -> Core. BFFs must not become a second business-data store.
- Core must not rely on a browser-wide ambient session cookie as its primary authentication mechanism. Untrusted clients use appropriately scoped short-lived bearer credentials. Owner-controlled trusted services may instead use individually scoped, opaque, revocable Service API Tokens according to `docs/service-authentication.md`; OAuth `client_credentials` remains an optional service mode, not the only one.
- Mini Programs, devices, Agents, and automation services use explicit app/device/service identities and scopes appropriate to their execution mode.
- CORS is not authorization. If direct browser-to-Core access is supported, use an exact Origin allowlist and still enforce token, app-scope, data permissions and model policy in Core.

## Contract workflow

For any public API or behavior change:

1. Update explicit Kernel contract inputs and/or the published Model/Capability definition that owns the behavior.
2. Update architecture or permission documentation when boundaries or authorization change.
3. Update implementation.
4. Update migrations or deterministic ordinary-model physical schema planning when persistence changes.
5. Add or update automated tests and contract-generation checks.
6. Regenerate canonical OpenAPI/JSON Schema and published contract/client artifacts instead of hand-editing generated model surfaces.
7. Record compatibility and downstream application impact.

Applications must consume an explicit compatible contract version. They must not silently track an unversioned "latest" Core contract.

## Adding an ordinary business model

Before publishing a model such as goals, assets, health records, credentials, growth records, school records or future ordinary domains, define through Model Definition / registered Capabilities:

- owning Space and subject/person semantics;
- supported principals and model access capabilities;
- read/write/manage policy and sensitive-data restrictions;
- cross-Space sharing/grant behavior;
- field schema and time/date semantics;
- indexes/query/search/aggregate requirements;
- lifecycle, soft deletion and concurrency behavior;
- required reusable Capabilities;
- actions/workflows and computed fields where supported;
- notifications/webhooks/AI interpretation participation where enabled;
- contract and downstream-app impact.

Do not create a new handwritten domain router/service simply because the DSL cannot yet express a requirement. Decide whether the missing behavior belongs in a reusable Capability/Engine or is truly a Kernel exception, document that decision, then implement the reusable abstraction.

## Repository discipline

- Keep platform code, contracts, Model Definitions, Kernel migrations and deployment configuration in this repository; keep application UI, external-provider identity mapping and app-specific BFF behavior in the application repositories.
- Ordinary model publication after typed-storage convergence may mutate validated model physical schema at runtime without creating a repository migration for each model. This does not weaken the rule that Kernel/Identity deployment schema history remains repository-owned.
- Do not copy HomeMew code mechanically. Preserve proven behavior as semantic tests/capability requirements where appropriate, but remove HomeMew/family-specific assumptions unless they are deliberate Space policies.
- Do not introduce packages that have no concrete consumer or clearly documented near-term role.
- Generated artifacts must be reproducible and clearly marked; never hand-edit them.
- Preserve standard API success/error envelopes and request tracing once the canonical contract defines them.
- Production and staging resources must be isolated. Never point staging at production D1/R2/Queue resources.
- Do not commit credentials, JWT keys, OAuth secrets, Cloudflare tokens, application secrets, external-provider IDs, or user data.

## Change completion

Before declaring a platform change complete, inspect all coupled surfaces: Identity, Space/Grant rules, Model Registry, Runtime Model Descriptor cache, physical schema planning, Generic Runtime, Capabilities, contracts/generation, migrations, tests, SDK/client generation, docs, infrastructure and downstream compatibility. Fix drift in the same change or explicitly record an approved follow-up while keeping unsupported functionality unavailable.
