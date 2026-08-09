# LifeSpace Platform

LifeSpace is the shared life-data platform behind ALOHA, HomeMew, and future vertical applications.

The platform owns global Identity integration, Space/Grant authorization, shared domain models, canonical contracts, migrations, and Cloudflare deployment configuration. Application repositories own UI, application-specific BFF behavior, and product presentation.

## Planned repository layout

```text
apps/
  core/        Shared business Core Worker
  identity/    Global Identity / OAuth / SSO Worker
packages/
  contracts/   Versioned generated/published contracts
  client/      Platform client/SDK generated from contracts
docs/          Architecture, permission and contract decisions
infra/         Shared infrastructure/deployment notes and configuration
```

Service-owned D1 migrations remain inside the service that owns the database, for example `apps/core/migrations` and `apps/identity/migrations`.

## Architecture principles

- One global human identity can participate in many Spaces.
- Every business record belongs to exactly one source Space.
- Sharing uses Data Grants; it does not copy or move the source record.
- Effective access is data authorization intersected with application scope.
- Core is a modular monolith and the source of truth for shared life-domain data.
- Identity authenticates principals and issues credentials; Core owns Space and business authorization.
- Web applications should prefer a same-origin BFF that calls Core through a Cloudflare Service Binding.
- Mini Programs, devices, Agents, and services call the platform with explicit scoped credentials.

## Current phase

Phase 1 platform foundation is complete and verified in isolated Cloudflare staging. Work now moves to Phase 2: migrate HomeMew capabilities to functional parity as complete vertical slices, while keeping HomeMew production Core as the baseline until cutover.

Read `AGENTS.md` and `docs/` before making changes.
