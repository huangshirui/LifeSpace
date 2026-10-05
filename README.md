# LifeSpace Platform

LifeSpace is a shared-reality platform consumed by replaceable applications, Agents, services and protocol adapters.

It is the platform source of truth for global LifeSpace Identity, Space/Data Grant authorization, metadata-driven domain models, reusable business capabilities, canonical contracts, migrations, and Cloudflare deployment configuration. Application repositories own product UI, application-specific provider adapters/BFF behavior, and product presentation.

## Repository layout

```text
apps/
  core/        LifeSpace Core Worker: Spaces, Grants, Model Registry, Generic Runtime and Capabilities
  identity/    LifeSpace Identity Worker: users, application/service credentials and Web Access principals
  console/     LifeSpace platform administration UI/BFF
docs/          Current architecture, authorization, contracts and platform specifications
infra/         Shared Cloudflare deployment, verification and platform operations
```

Service-owned D1 migrations live with the service that owns the database, for example `apps/core/migrations` and `apps/identity/migrations`.

## Architecture

### Identity

A human has one global LifeSpace `usr_*` identity across applications and Spaces.

Application-specific provider identities remain application-owned. Applications resolve provider subjects to LifeSpace `usr_*` identities through their own adapters/BFFs; LifeSpace Identity does not become a generic external-provider identity store.

Cloudflare Access is the deliberate Web exception and the long-term authentication/SSO layer for owner-controlled LifeSpace Web/PWA/Admin applications:

```text
Browser
  -> Cloudflare Access
  -> same-origin application BFF
  -> LifeSpace Identity independently verifies the Access JWT
  -> (iss, sub) -> global usr_*
  -> aud -> registered LifeSpace application context
  -> short-lived app-scoped LifeSpace credential
  -> LifeSpace Core
```

Identity owns verified Access principal resolution/linking. Individual applications must not maintain their own Access-subject -> `usr_*` mapping. Google OAuth, Microsoft OAuth and email OTP remain upstream Cloudflare Access login methods rather than separate LifeSpace IdP implementations.

### Space, data and authorization

- Every ordinary business record belongs to exactly one source Space.
- Sharing uses current Data Grants; it never moves or duplicates the authoritative source record.
- Whole-Space Data Grants authorize the Space boundary; Kernel 0.13.0 also supports model-collection Grants so one service principal can receive different read/write authority for different published models in the same Space.
- Effective permission is the intersection of verified principal, credential scope, Application × Model Access, current Space membership/Data Grant authority, published model access capability, and model policy/Capability restrictions.
- Entity type and operation role are distinct: User/Service/Device/Agent capability determines whether an entity may participate, while Principal is whose Authority is exercised and Actor is who/what executes the operation.
- An Agent may be a direct Principal only when it owns explicit Authority such as an Agent Data Grant; Agent identity alone grants nothing.
- Represented Agent execution preserves the Root Principal and uses an explicit current Delegation or bounded Delegation-chain. Re-delegation may narrow scope/access/expiry/depth but never change the Root Principal.
- The authenticated actor always comes from verified credentials; clients cannot assert an arbitrary current `userId` or Agent identity.

### Metadata-driven Core

LifeSpace Core is a modular monolith. Ordinary business models are published metadata interpreted by a fixed Generic Runtime rather than handwritten CRUD modules.

Published Model Definitions drive schema validation, typed physical storage, CRUD/query behavior, relations, optimistic concurrency, actions and Capability contributions. Current reusable platform capabilities include Calendar, Temporal/Cycle, Workflow/Policy, Registry-driven AI Creation Drafts, and Queue/async orchestration.

Core contract surface is split into:

```text
Kernel Contract
  explicit Kernel APIs in apps/core/openapi.yaml

Model Contract Revision
  immutable content-addressed mct_<sha256> generated from published models/capabilities
```

Applications pin explicit compatible contract versions instead of consuming an unversioned latest model surface.

## Authentication modes

| Client/workload | Preferred authentication |
| --- | --- |
| Owner-controlled Web/PWA/Admin | Cloudflare Access + same-origin BFF + LifeSpace Identity Access exchange |
| Mini Program / application-specific provider | Application backend resolves provider identity, then `lsa_*` trusted application exchange |
| Owner-controlled automation/script/backend | Opaque revocable `lsp_svc_*` Service API Token (legacy `lsp_pat_*` remains accepted until rotate/revoke) |
| Agent execution | Application-authenticated short-lived Core-only Agent execution token; direct Agent uses its own Authority, represented Agent additionally requires current Delegation |
| Third-party/policy-controlled service | OAuth 2.0 `client_credentials` |

Browser, Mini Program and downloadable client code must never contain `lsa_*`, service credentials, signing keys, provider secrets or other backend secrets.


## Current contracts and Identity × Cloudflare Access work

The current repository Core Kernel contract is **0.43.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel 0.43.0 includes the generalized Authority v3 foundation plus bounded atomic 1..20 multi-Delegation issuance; every issued `dlg_*` remains an independent single-scope object. Production availability remains separately frozen under `docs/production/*`.

The current repository Identity Application Contract is **0.7.0**. It preserves the legacy delegated-Agent token request and adds generalized short-lived `purpose=agent_execution` Core-only credentials where the actual Agent Actor is authenticated independently from the signed Principal operation role. Identity verifies entity/application identity; Core remains authoritative for current Data Grant, Delegation-chain, Space/model authorization and governed Change semantics. The Access architecture also includes:

- independently verified Access RS256 JWTs and JWKS key rotation;
- environment-pinned Access issuer;
- Access audience registration bound to trusted LifeSpace Web applications;
- `(iss, sub)` principal -> global `usr_*` resolution;
- strict Access `aud` + `lsa_*` application agreement;
- explicit atomic new-user registration without email-based merging;
- short-lived, high-entropy, single-use existing-account link challenges;
- multiple verified Access principals may link to one LifeSpace user.

## Environments

Staging and production resources are isolated.

```text
staging:
  auth-staging.aisr.online
  core-staging.aisr.online

production:
  auth.aisr.online
  core.aisr.online
```

Do not point staging Workers, D1, R2, Queues or credentials at production resources.

## Development and verification

Use Node.js 24 and the repository-pinned pnpm version.

The repository-wide validation entry point is:

```bash
pnpm check
```

Service-specific migrations and deployment configuration are repository-owned. Staging deployment applies migrations before deploying compatible Workers and then runs platform-owned database, authentication, contract and model-runtime verification gates.

## Read before changing the platform

Start with `AGENTS.md`, then the relevant source-of-truth documents:

- `docs/architecture.md` — platform/runtime and Identity boundaries
- `docs/permissions.md` — authorization model
- `docs/authority-role-capability-redelegation.md` — accepted Entity Role Capability, Agent Principal and bounded re-delegation architecture
- `docs/model-scoped-data-grants.md` — whole-Space vs model-collection Grant semantics
- `docs/service-authentication.md` — service/Agent/machine credentials
- `docs/contracts.md` — Kernel/model contract ownership and publication
- `docs/model-platform-architecture.md` — metadata-driven model architecture
- `docs/runtime-storage-performance.md` — runtime/storage performance invariants
- `docs/generic-consumer-contract.md` — consumer-neutral semantic projection and authority boundary
- `docs/application-authentication.md` — trusted application and Cloudflare Access Identity contracts
