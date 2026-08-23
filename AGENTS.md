# LifeSpace Agent Instructions

LifeSpace is the shared life-data platform behind ALOHA, HomeMew and future vertical applications. It is the sole source of truth for global LifeSpace user identity, Space/Data Grant authorization, shared domain models, platform migrations, contracts and deployment configuration.

## Read before making changes

Read in this order:

1. `docs/architecture.md`;
2. `docs/permissions.md`;
3. `docs/application-authentication.md` for Web/Access/application identity work;
4. `docs/service-authentication.md` for service, Agent, automation, device or machine credentials;
5. `docs/contracts.md`;
6. `docs/phase3-metadata-platform-plan.md` for business-model/runtime architecture;
7. `docs/phase3-performance-convergence-plan.md` for ordinary-model storage, Registry runtime lookup, query hydration, authorization I/O or performance-sensitive paths;
8. `docs/migration-plan.md` when changing/moving HomeMew behavior;
9. `apps/AGENTS.md` and the nearest nested `AGENTS.md` for every directory changed;
10. relevant OpenAPI contracts, tests, migrations, implementation, Model Definitions and generated artifacts.

If a required source does not yet exist during initial scaffold, create/update it before implementing behavior that depends on it.

## Sources of truth

- Platform boundaries/topology: `docs/architecture.md`
- Space ownership, Grants, principals and effective authorization: `docs/permissions.md`
- Application/Cloudflare Access identity: `docs/application-authentication.md`
- Service/machine credential policy: `docs/service-authentication.md`
- Contract ownership/versioning/publication/downstream consumption: `docs/contracts.md`
- Metadata business-model architecture: `docs/phase3-metadata-platform-plan.md`
- Runtime performance/typed persistence: `docs/phase3-performance-convergence-plan.md`
- Core business-facing Kernel API: `apps/core/openapi.yaml`
- Core privileged Platform Admin API: `apps/core/platform-admin.openapi.yaml`
- Identity application/user/service API: `apps/identity/openapi.yaml`
- Identity privileged Platform Admin API: `apps/identity/platform-admin.openapi.yaml`
- Ordinary business-model semantics/contracts: validated Model Definitions / Model Registry / immutable `mct_*` revisions
- Database history: service-owned migrations
- Verified behavior: automated tests
- Implementation details: source code

Do not silently reconcile disagreements between these sources. Preserve deployed behavior unless the task explicitly changes the contract/boundary.

## Mandatory platform rules

### Identity

- LifeSpace user identity is global: one natural person has one platform `usr_*` across applications and Spaces.
- Application-specific external identities are not LifeSpace identities. WeChat `openid`, WeCom IDs, school-provider IDs and similar subjects remain mappings owned by the application adapter/BFF.
- Cloudflare Access platform principals are the deliberate shared-Web exception: Identity owns verified `(iss, sub) -> usr_*` mapping and account linking.
- Access `aud` identifies the protected application context and must be registered to the intended LifeSpace application; it is not part of the user key.
- Access email/display claims are non-authoritative and must never silently merge accounts.
- Unknown Access principals require explicit create-new-account or proof-backed link-existing-account flow.
- A trusted application backend may assert an already-resolved `usr_*` only with its own revocable `lsa_*`; Identity derives `azp`, scope ceiling and token TTL from current registered application state.
- Never trust browser/Mini Program input containing arbitrary `userId`, Access `sub`, email or decoded claims as authentication authority.
- Identity remains a LifeSpace credential/principal service, not a parallel Google/Microsoft/email IdP while Cloudflare Access remains the approved Web SSO layer.

### Space and data authorization

- Space is the ownership/default authorization boundary for ordinary business data.
- Every ordinary business record belongs to exactly one source Space.
- Sharing never changes ownership or creates a second authoritative copy; use Data Grants/approved derived views.
- Data authorization and application authorization are independent.
- Effective ordinary-model permission is the intersection of verified principal, credential scope, Application × Model Access, current Space membership/Data Grant, published model capability and model policy/Capability restrictions.
- The authenticated actor comes from verified credentials, never request `userId`.
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
- Platform-admin audit must distinguish human actor from backend/service executor and never persist credential plaintext/hashes/Authorization headers.
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
- `lsa_*` authenticates a trusted application backend to Identity; `lsp_pat_*`/service JWT authenticates a service principal to Core. Do not conflate them.
- Service/device identities receive only explicit credential scopes, Application × Model Access and Data Grants.
- Permanent personal-user API tokens are not a service-authentication substitute.

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
- supported principals and access capabilities;
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
- Do not copy HomeMew code mechanically; preserve proven semantics while removing family/app assumptions that are not platform policy.
- Do not introduce packages without a concrete consumer/near-term role.
- Generated artifacts are reproducible outputs and must not be hand-edited.
- Production/staging resources and credentials remain isolated.
- Never commit credentials, JWT private keys, OAuth secrets, Cloudflare tokens, application/service secrets, provider IDs or user data.

## Change completion

Before declaring a platform change complete, inspect all coupled surfaces: Identity, Access/application auth, platform-admin actor/executor state, Space/Grant rules, Application × Model Access, Registry, runtime descriptor cache, physical schema, Generic Runtime, Capabilities, all applicable contract layers, migrations, tests, SDK/client generation, docs, infrastructure and downstream compatibility. Fix drift in the same change or record an explicit approved follow-up while keeping unsupported behavior unavailable.
