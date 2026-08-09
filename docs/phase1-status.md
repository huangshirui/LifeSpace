# Phase 1 Status — LifeSpace platform foundation

Updated: 2026-08-09

Phase 1 is **in progress**. The repository foundation, first working Core/Identity implementation, and D1-backed authorization integration coverage are complete. The remaining P0 work is to provision/deploy isolated Cloudflare staging resources and pass the real staging end-to-end gate.

## Completed

### Engineering/runtime foundation

- [x] Hono + Cloudflare Worker projects for Core and Identity.
- [x] Separate Core and Identity D1 migration histories.
- [x] Explicit staging/production Wrangler environments with intentionally invalid placeholder D1 IDs until provisioning.
- [x] Node.js 24 + pnpm workspace.
- [x] TypeScript, Vitest, OpenAPI sanity checks and Wrangler dry-run builds.
- [x] CI runs repository `contract -> test -> typecheck -> build` checks.
- [x] Standard JSON success/error envelopes and `x-request-id` foundation.
- [x] `/health` and `/api/v1/status` foundation with schema/contract diagnostics.
- [x] Cloudflare Workers Vitest integration runs tests in `workerd` with real D1 bindings and repository migrations.

### Identity foundation

- [x] Global LifeSpace `usr_*` users.
- [x] Application/client registration.
- [x] Application-owned external identity boundary: provider IDs such as HomeMew WeChat `openid` remain in the owning application adapter/BFF.
- [x] Per-application trusted-backend credentials stored as hashes and returned only once when created.
- [x] Trusted application user creation and user assertion/token exchange boundary.
- [x] RS256 token signing in Identity and public-key verification in Core.
- [x] Token claims include `iss`, `aud`, `sub`, `azp`, `principal_type`, scopes, `iat`, `exp`, and `jti`.
- [x] Requested scopes cannot exceed the authenticated application's registered maximum scopes.
- [x] Access-token TTL is an application policy in the 300-3600 second range; HomeMew Mini Program target is 3600 seconds.
- [x] D1-backed tests cover application credential authentication, hash-only credential persistence, app scope ceiling, disabled users, and per-application TTL.

### Core ownership/authorization foundation

- [x] `spaces`.
- [x] `space_memberships`.
- [x] `space_people`.
- [x] Space-level `data_grants` persistence.
- [x] Initial roles: owner/admin/editor/viewer.
- [x] Initial permissions: free_busy/read/write/manage.
- [x] App scopes are checked independently from Space membership/Data Grant permission.
- [x] `/api/v1/me` and `/api/v1/me/spaces` foundation.
- [x] Space create/read, member listing/addition and Data Grant creation foundation.
- [x] D1-backed tests cover membership allow/deny, Data Grant permission rank/expiry/revocation, app-scope × data-permission intersection, and cross-Space isolation.

## Remaining before Phase 1 exit gate

### P0 — required before starting Phase 2 domain migration

- [ ] Provision isolated staging D1 databases and replace staging placeholder IDs.
- [ ] Generate/configure staging RS256 key pair, Identity bootstrap secret, and trusted test application credential.
- [ ] Deploy Identity and Core to staging and verify `/health` and `/api/v1/status` against real D1 bindings.
- [ ] Run an end-to-end staging path: trusted application -> create/resolve user -> Identity token -> Core -> create/read Space.

### P1 — should be completed in Phase 1, but not a blocker for writing the first Phase 2 PR if the P0 exit gate is already green

- [ ] Implement an actual token-revocation check or explicitly narrow Phase 1 revocation scope; the persistence table currently exists but Core does not consult it on each request.
- [ ] Define key-rotation/JWKS rollout mechanics beyond the current static public-key configuration.
- [ ] Complete service/device principal issuance flows if they are required by the first migrated HomeMew capabilities; current Core vocabulary anticipates them but Identity Phase 1 token issuance is user-focused.
- [ ] Decide whether production direct-browser Core CORS is needed at all once application BFFs are introduced; keep exact-origin allowlists if it remains supported.
- [ ] Synchronize the older Phase 1 checklist in `docs/migration-plan.md` with the corrected application-owned external-identity boundary and this status document.

## Explicitly not required for Phase 1

These are not blockers for the HomeMew migration foundation:

- Platform-owned Web SSO/browser sessions.
- Google/Microsoft/WeChat provider integrations inside LifeSpace Identity.
- HomeMew's actual WeChat Cloud Function migration to LifeSpace.
- Events, tasks, day records, wishes or other HomeMew business domains.
- Cross-Space `/me/events` and `/me/tasks` aggregation.
- Production Cloudflare resources.

Those belong to later migration/application phases unless a concrete dependency moves them earlier.

## Exit gate

Phase 1 is complete only when all of the following are true:

1. Identity and Core are independently deployed to isolated staging resources.
2. A trusted test application can resolve/create a LifeSpace user and obtain an app-scoped credential from Identity.
3. The credential can create/read a Space in Core against real staging D1.
4. Membership, Data Grant, app-scope intersection, expiry/revocation and cross-Space isolation are covered by D1-backed tests.
5. `/health` and `/api/v1/status` confirm expected staging runtime, schema and contract versions.
6. Repository CI passes contract, tests, typecheck and build.

Do not begin bulk HomeMew domain migration until this gate is satisfied.
