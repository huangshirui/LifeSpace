# Core Agent Instructions

LifeSpace Core is the shared business API and source of truth for Spaces, Data Grants and life-domain records.

## Before changing Core

Read:

1. Root `AGENTS.md`
2. `docs/architecture.md`
3. `docs/permissions.md`
4. `docs/contracts.md`
5. `docs/migration-plan.md` when porting HomeMew behavior
6. Core contract, migrations, tests and relevant implementation once present

## Core responsibilities

Core owns:

- Spaces and Space membership.
- Data Grants and current authorization evaluation.
- Shared domain models such as events, tasks, day records, wishes, anniversaries, goals, assets/maintenance, health, credentials, growth and school records as they are approved and implemented.
- Cross-Space aggregate queries under authenticated `/me` views.
- Domain validation, concurrency, soft deletion, audit fields, search/filter semantics and lifecycle cleanup.
- Canonical Core OpenAPI and business D1 migrations.

Core does not own:

- External provider login or SSO browser sessions.
- WeChat `openid`, Google subject IDs, email OTP flows or other provider-specific authentication mappings.
- Application UI state or application-specific navigation.
- A second copy of application BFF session state.

## Authorization rules

- Every business record must have exactly one source `space_id` unless a domain is explicitly documented as platform-global metadata.
- Every read/write must evaluate the authenticated principal, current Space/Data Grant authorization, calling app scope and domain restrictions.
- Never treat `space_id` existence as proof of access.
- Never trust request `userId` as actor identity.
- Cross-Space aggregate endpoints must preserve source Space and effective capability in returned records where the client needs to distinguish writable from shared/read-only data.
- Revoking membership or a Data Grant must take effect from current authorization state; do not rely only on long-lived token claims.

## HomeMew migration rules

Use HomeMew Core as a behavioral reference, especially for Workers/Hono structure, D1 migrations, request IDs, response envelopes, OpenAPI checks, tests, optimistic concurrency, soft deletion, time/date semantics, queues and AI privacy boundaries.

Do not mechanically port:

- `family_id` ownership assumptions.
- HomeMew-specific user identity ownership.
- Family-only role checks where Space/Data Grant rules are required.
- HomeMew integration permission names when platform scopes should be generalized.

When preserving behavior, add tests that prove equivalent semantics under the new Space model.

## Persistence

- Core D1 migrations belong under `apps/core/migrations`.
- Important invariants should be enforced in D1 when cheap and reliable.
- Avoid schema designs that require application clients to repair referential integrity.
- Migration and Worker rollout order must be compatible and documented.

## Verification

Once implementation exists, a Core change is incomplete until canonical contract checks, tests, type checks and dry-run build pass. A new domain requires authorization/isolation tests in addition to CRUD happy paths.
