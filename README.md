# LifeSpace Platform

LifeSpace is the shared life-data platform behind ALOHA, HomeMew, and future vertical applications.

It is the platform source of truth for global LifeSpace Identity, Space/Data Grant authorization, metadata-driven domain models, reusable business capabilities, canonical contracts, migrations, and Cloudflare deployment configuration. Application repositories own product UI, application-specific provider adapters/BFF behavior, and product presentation.

## Repository layout

```text
apps/
  core/        LifeSpace Core Worker: Spaces, Grants, Model Registry, Generic Runtime and Capabilities
  identity/    LifeSpace Identity Worker: users, application/service credentials and Web Access principals
packages/
  contracts/   Reproducible versioned/pinned platform contract artifacts
  client/      Platform client/SDK surface built against explicit contracts
docs/          Architecture, authorization, contracts, migration plans and phase evidence
infra/         Shared Cloudflare deployment, verification and migration tooling
```

Service-owned D1 migrations live with the service that owns the database, for example `apps/core/migrations` and `apps/identity/migrations`.

## Architecture

### Identity

A human has one global LifeSpace `usr_*` identity across applications and Spaces.

Application-specific provider identities remain application-owned. For example, HomeMew owns its WeChat `openid -> usr_*` mapping in the HomeMew application backend; LifeSpace Identity does not become a generic external-provider identity store.

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
| Owner-controlled n8n/script/MCP/backend | Opaque revocable `lsp_pat_*` Service API Token |
| Third-party/policy-controlled service | OAuth 2.0 `client_credentials` |

Browser, Mini Program and downloadable client code must never contain `lsa_*`, service credentials, signing keys, provider secrets or other backend secrets.

## HomeMew status

HomeMew is already cut over to LifeSpace production as the authoritative writable platform for migrated household data.

Phase 7 completed the controlled one-shot production migration and activation on 2026-08-21. Current production routing is:

```text
homemew.aisr.online -> HomeMew Cloudflare backend
                       -> auth.aisr.online
                       -> core.aisr.online
```

The legacy HomeMew Core/D1 is retained frozen/read-only only for the Phase 8 stabilization and rollback-evidence window. There is no dual-write or permanent compatibility Core.

Current migration status:

| Phase | Status |
| --- | --- |
| Phase 1 — platform foundation | Complete |
| Phase 2 — native HomeMew capability parity | Complete |
| Phase 3 — metadata-driven runtime / typed storage / performance convergence | Complete |
| Phase 4 — HomeMew integration readiness | Complete |
| Phase 5 — one-shot migration rehearsal | Complete |
| Phase 6 — isolated production platform deployment | Complete |
| Phase 7 — HomeMew production migration and cutover | Complete |
| Phase 8 — stabilization and old-infrastructure retirement | **In progress** |
| Phase 9 — post-cutover aggregation/sharing evolution | Non-blocking |

See `docs/migration-plan.md` and `docs/phase7-status.md` for the migration/cutover evidence.

## Current contracts and Identity × Cloudflare Access work

The current repository Core Kernel contract is **0.22.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel evolution since 0.13.0 has added Agent Delegation/governed Change, cross-Space Runtime Discovery, authoritative server defaults, explicit Action semantic-input/concurrency metadata, ordered multi-field Generic Query sorting, and canonical human-facing field titles while preserving the Stable Spine invariants.

The current repository Identity Application Contract is **0.6.0**. It extends the accepted Cloudflare Access platform-identity architecture with first-class Agent identity and short-lived Core-only delegated Agent execution credentials. The Access architecture includes:

- independently verified Access RS256 JWTs and JWKS key rotation;
- environment-pinned Access issuer;
- Access audience registration bound to trusted LifeSpace Web applications;
- `(iss, sub)` principal -> global `usr_*` resolution;
- strict Access `aud` + `lsa_*` application agreement;
- explicit atomic new-user registration without email-based merging;
- short-lived, high-entropy, single-use existing-account link challenges;
- multiple verified Access principals may link to one LifeSpace user.

The earlier Identity 0.5.0 HomeMew Web staging Access proof remains historical acceptance evidence; it is not the current repository contract label. The existing HomeMew Mini Program production identity path continues to use its application-owned WeChat mapping and trusted application exchange.

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
- `docs/phase3-metadata-platform-plan.md` — metadata-driven model architecture
- `docs/phase3-performance-convergence-plan.md` — runtime/storage performance invariants
- `docs/migration-plan.md` — HomeMew migration/cutover rules and current phase status
- `docs/application-authentication.md` — trusted application and Cloudflare Access Identity contracts
