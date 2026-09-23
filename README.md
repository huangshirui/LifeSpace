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
- The authenticated actor always comes from verified credentials; clients cannot assert an arbitrary current `userId`.

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
| Owner-controlled automation/script/backend | Opaque revocable `lsp_pat_*` Service API Token |
| Third-party/policy-controlled service | OAuth 2.0 `client_credentials` |

Browser, Mini Program and downloadable client code must never contain `lsa_*`, service credentials, signing keys, provider secrets or other backend secrets.


## Current contracts and Identity × Cloudflare Access work

The current repository Core Kernel contract is **0.38.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel evolution since 0.13.0 has added Agent Delegation/governed Change, cross-Space Runtime Discovery, authoritative server defaults, explicit Action semantic-input/concurrency metadata, ordered multi-field Generic Query sorting, canonical human-facing field titles, authorized source-field-aware Person relation target lookup, and progressive single-model static semantic detail while preserving the Stable Spine invariants. The progressive detail route uses a known Space only as a current visibility gate, returns static Model semantics derived from the shared semantic projection compiler, and does not expose effective Membership/Data Grant/Delegation state or replace execution-time authority checks. Relation lookup returns only minimal `{id,label}` references and remains a current capability projection rather than mutation authority.

The current repository Identity Application Contract is **0.6.0**. It extends the accepted Cloudflare Access platform-identity architecture with first-class Agent identity and short-lived Core-only delegated Agent execution credentials. The Access architecture includes:

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

Service-specific migrations and deployment configuration are repository-owned. Staging deployment applies migrations before deploying compatible Workers and then runs database, authentication, contract, model-runtime and HomeMew integration verification gates.

## Read before changing the platform

Start with `AGENTS.md`, then the relevant source-of-truth documents:

- `docs/architecture.md` — platform/runtime and Identity boundaries
- `docs/permissions.md` — authorization model
- `docs/model-scoped-data-grants.md` — whole-Space vs model-collection Grant semantics
- `docs/service-authentication.md` — service/Agent/machine credentials
- `docs/contracts.md` — Kernel/model contract ownership and publication
- `docs/model-runtime-architecture.md` — metadata-driven model architecture
- `docs/performance-invariants.md` — runtime/storage performance invariants
- `docs/application-authentication.md` — trusted application and Cloudflare Access Identity contracts
