# LifeSpace Core

Shared Cloudflare Worker business API for Space-owned life data.

## Implemented platform foundation

- Verified RS256 principal authentication and application scopes.
- Space ownership with roles `owner`, `admin`, `editor`, and `viewer`.
- Current Space membership and Data Grant authorization intersection.
- Linked Space People for person-subject domain relationships.
- Health/status diagnostics and standard success/error envelopes.

## Phase 2 family Space management

Core API contract version 0.3.0 contains the native family Space policy and the temporary HomeMew family compatibility facade:

- Every Space stores an IANA `timezone`; native creation defaults to `UTC` when omitted.
- Space profile updates require optimistic-concurrency `version`.
- Family Spaces allow at most eight active memberships.
- A Space always retains at least one active owner or administrator.
- Membership activation/deactivation keeps its linked Space Person consistent.
- Core owns hashed, expiring, revocable Space invitations. Plaintext invitation tokens are returned only once at creation.
- Invitation redemption atomically validates lifecycle/use/member limits and creates or reactivates both membership and Space Person.

The compatibility routes translate `fam_*`, HomeMew roles, legacy field names, and response codes over the same native records. They do not create a second family data model. The HomeMew maximum-three-created-families rule is enforced only when a family is created through `/api/v1/families`; native Space creation has no such platform-wide limit. HomeMew family avatar values remain `null` until the R2 object migration slice.

## HomeMew family snapshot transform

`scripts/homemew-family-transform.mjs` accepts a normalized HomeMew schema-v11 JSON snapshot with these arrays:

- `users`
- `families`
- `familyMembers`
- `familyInvites`
- `inviteRedemptions`

The `source` object must include `schemaVersion: "11"` and an RFC 3339 UTC `exportedAt`. Source fields use the HomeMew column meaning in camelCase, including durable IDs, statuses, roles, hashes, timestamps, and optional avatar keys.

Run:

```sh
node scripts/homemew-family-transform.mjs --input homemew-family-snapshot.json --out-dir migration-output
```

The command validates references and family invariants, then writes deterministic `identity.sql`, `core.sql`, `mapping-manifest.json`, and `migration-report.json`. SQL output targets fresh LifeSpace databases that already have the current service migrations applied. Avatar keys are counted as deferred objects but are not copied by this slice.

Canonical request and response syntax lives in `openapi.yaml`. D1 migrations live in `migrations/` and are applied before deploying the compatible Worker.

## Verification

`pnpm --filter @lifespace/core check` runs the OpenAPI contract check, Workers-runtime D1 tests, Node migration-transform tests, TypeScript checking, and Wrangler dry-run build.
