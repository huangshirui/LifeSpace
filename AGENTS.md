# LifeSpace Agent Instructions

LifeSpace is the shared life-data platform behind ALOHA, HomeMew, and future vertical applications. It is the sole source of truth for global LifeSpace user identities, Space/Grant authorization, shared business-domain models, migrations, API contracts, and platform deployment configuration.

## Read before making changes

Read these files in order:

1. `docs/architecture.md`
2. `docs/permissions.md`
3. `docs/contracts.md`
4. `docs/migration-plan.md` when changing or moving behavior from HomeMew
5. The nearest nested `AGENTS.md` for every directory being changed
6. Relevant OpenAPI, tests, migrations, implementation, and generated artifacts

If a referenced file has not been created yet during the initial scaffold, create or update it before implementing behavior that depends on it.

## Sources of truth

- Platform boundaries and runtime topology: `docs/architecture.md`
- Space ownership, Data Grant semantics, roles, principals, and effective authorization: `docs/permissions.md`
- Contract ownership, versioning, publication, and downstream consumption: `docs/contracts.md`
- Core API syntax: `apps/core/openapi.yaml`
- Identity API syntax: `apps/identity/openapi.yaml`
- Database history: migrations owned by the service that owns the database
- Verified runtime behavior: automated tests
- Implementation details: source code

Do not silently reconcile disagreements between these sources. Preserve deployed behavior unless the task explicitly changes the contract, and update contract, implementation, tests, docs, migrations, and affected consumers together.

## Mandatory platform rules

- LifeSpace user identity is global. A human user has one platform `user_id` regardless of which applications or Spaces they use.
- Application-specific external identities are not LifeSpace identities. WeChat `openid`, WeCom `userid`, school-platform IDs, and similar provider identifiers are resolved and mapped by the owning application adapter/BFF, not by Core and not by the generic LifeSpace Identity service.
- A trusted application backend may assert an already-resolved LifeSpace `user_id` to Identity only with its own revocable application credential. Identity must derive the calling application from that credential and constrain issued scopes to the application's registered maximum scopes.
- Never trust a browser, Mini Program, or other untrusted client to submit an arbitrary `user_id` for token issuance. External-provider credentials and mapping data stay in the owning application boundary.
- A Space is the ownership and default authorization boundary for business data. Every business record belongs to exactly one source Space.
- Sharing never changes data ownership and must not create a second source-of-truth copy. Cross-user and cross-Space visibility is expressed through Data Grants or approved derived views.
- Data authorization and application authorization are independent. Effective permission is the intersection of the principal's current data authorization and the calling application's granted scopes.
- The authenticated actor comes from verified credentials. Never trust a client-provided `userId` as the current actor.
- Core owns Space/Grant authorization and business-domain authorization. Clients and BFFs may hide controls for usability but are never the security authority.
- Identity owns LifeSpace users, trusted application/client registration and credentials, platform SSO/session capabilities when explicitly implemented, short-lived token issuance/revocation, and signing-key lifecycle. Identity must not become an integration hub for every application's external login provider.
- Keep `Data Grant` terminology distinct from OAuth authorization grants or consent records.
- ALOHA, HomeMew, and vertical applications are clients of the platform. Do not add application-specific business rules to Core merely because one current client needs a particular UI flow.
- Keep Core a modular monolith unless a separately approved architecture decision justifies splitting a runtime service.
- Do not build a universal JSON `resources` table as a substitute for explicit domain models. Shared ownership and permission fields may be common, but domain invariants must remain explicit.
- Cross-Space aggregate queries such as `/api/v1/me/events` are a Core capability. Do not force every client to rediscover and merge all accessible Spaces itself.

## Identity and browser security

- Unified Identity does not mean a shared parent-domain browser cookie.
- Do not use `Domain=aisr.online` or another parent-domain session cookie to share sessions between applications.
- If platform SSO is implemented, Identity browser sessions use host-only Secure HttpOnly cookies on the Identity host. Individual Web applications may maintain their own host-only App Session through a same-origin BFF.
- Web applications should prefer browser -> same-origin BFF -> service binding -> Core. BFFs must not become a second business-data store.
- Core must not rely on a browser-wide ambient session cookie as its primary authentication mechanism. Non-browser clients and service-to-service calls use appropriately scoped short-lived bearer credentials.
- Mini Programs, devices, Agents, and automation services use explicit app/device/service identities and scopes appropriate to their execution mode.
- CORS is not authorization. If direct browser-to-Core access is supported, use an exact Origin allowlist and still enforce token, app-scope, and data permissions in Core.

## Contract workflow

For any public API or behavior change:

1. Update the owning service's canonical OpenAPI/JSON Schema contract.
2. Update architecture or permission documentation when boundaries or authorization change.
3. Update implementation.
4. Update migrations when persistence changes.
5. Add or update automated tests and contract checks.
6. Regenerate published contract/client artifacts instead of hand-editing generated files.
7. Record compatibility and downstream application impact.

Applications must consume an explicit compatible contract version. They must not silently track an unversioned "latest" Core contract.

## Adding a business domain

Before adding a domain such as goals, assets, health records, credentials, growth records, or school records, explicitly define:

- Owning Space and subject/person semantics.
- Supported principals: user, delegated Agent, system/service, device, or application.
- Read/write/manage permission model and any sensitive-data restrictions.
- Whether cross-Space sharing is allowed and at what granularity.
- Time/date semantics.
- Persistence invariants, IDs, indexes, lifecycle, soft deletion, and concurrency rules.
- Search, aggregate `/me` views, notifications, webhooks, AI-draft participation, and external integrations.
- Contract, SDK/client, migration, and downstream-app impact.

A domain is not complete when only its table and CRUD routes exist.

## Repository discipline

- Keep platform code, contracts, migrations, and deployment configuration in this repository; keep application UI, external-provider identity mapping, and app-specific BFF behavior in the application repositories.
- Do not copy HomeMew code mechanically. Preserve proven behavior where appropriate, but remove HomeMew/family-specific assumptions unless they are deliberate Space policies.
- Do not introduce packages that have no concrete consumer or clearly documented near-term role.
- Generated artifacts must be reproducible and clearly marked; never hand-edit them.
- Preserve standard API success/error envelopes and request tracing once the canonical contract defines them.
- Production and staging resources must be isolated. Never point staging at production D1/R2/Queue resources.
- Do not commit credentials, JWT keys, OAuth secrets, Cloudflare tokens, application secrets, external-provider IDs, or user data.

## Change completion

Before declaring a platform change complete, inspect all coupled surfaces: Identity, Space/Grant rules, Core domains, contracts, migrations, tests, SDK/client generation, docs, infrastructure, and downstream compatibility. Fix drift in the same change or explicitly record an approved follow-up while keeping unsupported functionality unavailable.
