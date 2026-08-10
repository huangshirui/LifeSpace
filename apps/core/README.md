# LifeSpace Core

Shared Cloudflare Worker business API for Space-owned life data.

## Implemented platform foundation

- Verified RS256 principal authentication and application scopes.
- Space ownership with roles `owner`, `admin`, `editor`, and `viewer`.
- Current Space membership and Data Grant authorization intersection.
- Linked Space People for person-subject domain relationships.
- Health/status diagnostics and standard success/error envelopes.

## Phase 2 family Space management

Core API contract version 0.2.0 adds the native family Space policy used by the HomeMew migration:

- Every Space stores an IANA `timezone`; native creation defaults to `UTC` when omitted.
- Space profile updates require optimistic-concurrency `version`.
- Family Spaces allow at most eight active memberships.
- A Space always retains at least one active owner or administrator.
- Membership activation/deactivation keeps its linked Space Person consistent.
- Core owns hashed, expiring, revocable Space invitations. Plaintext invitation tokens are returned only once at creation.
- Invitation redemption atomically validates lifecycle/use/member limits and creates or reactivates both membership and Space Person.

HomeMew's maximum-three-created-families rule is not a generic Space rule. It belongs to the later HomeMew compatibility/application policy. HomeMew family avatar parity is also deferred to the R2 object migration slice.

Canonical request and response syntax lives in `openapi.yaml`. D1 migrations live in `migrations/` and are applied before deploying the compatible Worker.

## Verification

`pnpm --filter @lifespace/core check` runs the OpenAPI contract check, Workers-runtime D1 tests, TypeScript checking, and Wrangler dry-run build.
