# Phase 2 Status — Native HomeMew capability migration

Updated: 2026-08-11

Phase 2 is **in progress**. Phase 1 staging is the accepted platform baseline. Phase 2.1-2.6, the native-only convergence/compatibility-retirement slice, and the native user-profile/R2-avatar slice are deployed and verified in staging. After Phase 2.6, the migration direction was reset: LifeSpace no longer targets a HomeMew runtime compatibility layer; remaining work targets the final native LifeSpace architecture and HomeMew will adapt its clients to that contract.

## Phase 2 objective

Ensure every production-used HomeMew shared backend capability has a complete native LifeSpace replacement and deterministic migration path while HomeMew production Core remains the writable baseline.

A remaining slice is complete only when native contract, D1 schema, authorization, implementation, lifecycle semantics, tests, migration transform where applicable, and staging verification move together. Legacy HomeMew URL/response compatibility is no longer a completion requirement.

## Direction reset after Phase 2.6

From 2026-08-11 onward:

- Do not add new `/api/v1/families/...` routes solely to keep the old HomeMew client unchanged.
- Do not preserve old HomeMew response field names solely as a platform façade.
- Do not add legacy HomeMew token verification to the LifeSpace target architecture.
- HomeMew product terminology may remain `family` / `member` in its UI, but application code will consume native `Space`, membership and Space Person contracts.
- Keep all migration mappings, transforms, validation reports and stable-ID preservation needed to move HomeMew data safely.
- Compatibility-only runtime routes, OpenAPI surfaces, translation logic and allowlists implemented in Phase 2.2-2.6 have now been retired from the target Core runtime.
- HomeMew-only product rules that are not platform invariants belong in the HomeMew application boundary.

This reset does **not** rewrite completed migration history. Phase 2.2-2.6 compatibility work was implemented and staging-verified under the previous plan; it is migration history rather than target architecture.

## Completed in Phase 2

### Baseline and controls

- [x] Inventory the 60 implemented HomeMew OpenAPI operations.
- [x] Inventory D1 schema v11, R2, Queue, cron, rate-limit, secrets, and released Mini Program consumers.
- [x] Classify durable, object, ephemeral, derived, and secret state.
- [x] Record external integrations and credential continuity requirements.
- [x] Establish the migration freeze rule.
- [x] Define family -> family Space role, person, timezone, invitation, member-limit and migration mappings.

### 2.1 Native family Space policy

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Add IANA `timezone` to Space contract and persistence.
- [x] Add optimistic Space update.
- [x] Add member role update, member removal and self-leave.
- [x] Enforce a family Space maximum of eight active members.
- [x] Enforce at least one active owner/admin.
- [x] Keep membership and linked Space Person consistent.
- [x] Add Core-owned Space invitations with secure token lifecycle and atomic join/reactivation.
- [x] Add authorization, concurrency, invitation and lifecycle tests.
- [x] Update canonical OpenAPI and contract checks.

### 2.2 Family migration + historical transitional compatibility

**Status: deployed and verified in staging on 2026-08-10; transitional runtime compatibility retired by Core 0.8.0 on 2026-08-11.**

Completed durable work that remains required:

- [x] Explicit `fam_* -> spc_*` and member/person migration maps.
- [x] Deterministic transforms and validation for users, families, memberships, Space People, invitations and redemption history.
- [x] Native Space records remain authoritative with no second family store.

Historical transitional work:

- [x] Temporary family-route compatibility was implemented under the previous plan and later retired.
- [x] Legacy role/field/status translation was implemented under the previous plan and later retired.
- [x] HomeMew compatibility-only three-created-family enforcement was implemented under the previous plan and later removed from generic Core policy.

### 2.3 Space-owned events

**Status: deployed and verified in staging on 2026-08-10; compatibility facade retired by Core 0.8.0 on 2026-08-11.**

- [x] Native Space-owned `events` with same-Space Space Person attendees.
- [x] Timed UTC/display-timezone and half-open all-day semantics.
- [x] Native CRUD/search/filter/pagination with scope × Space authorization.
- [x] Stable `evt_*` IDs, optimistic concurrency, audit snapshots and soft deletion.
- [x] Deterministic schema-v11 event transform.
- [x] Native D1/authorization/time/pagination/transform tests and staging E2E.
- [x] Temporary HomeMew event compatibility facade was retired from runtime and canonical contract.

### 2.4 Space-owned tasks

**Status: deployed and verified in staging on 2026-08-10; compatibility facade retired by Core 0.8.0 on 2026-08-11.**

- [x] Native Space-owned `tasks` and same-Space Person assignees.
- [x] Preserve pending/completed/cancelled lifecycle and date-only `dueDate`.
- [x] Native CRUD/complete/reopen routes with `tasks:read` / `tasks:write` scopes.
- [x] Stable `tsk_*` IDs, optimistic versions, actor snapshots and soft deletion.
- [x] Deterministic schema-v11 task transform and validation.
- [x] Native Workers/D1 tests and repeatable staging E2E.
- [x] Temporary HomeMew task compatibility facade was retired; native `includeNoDue` omission remains explicitly `false`.

### 2.5 Space-owned day records

**Status: deployed and verified in staging on 2026-08-11; compatibility facade retired by Core 0.8.0 on 2026-08-11.**

- [x] Native Space-owned day records and occurrence history.
- [x] Native `elapsed`, `countdown`, `cycle` discriminated semantics.
- [x] Space-timezone date-only computation and occurrence validation.
- [x] Same-Space Space Person subject model preserving historical subjects after deactivation.
- [x] Archive/restore, occurrence advancement, optimistic concurrency and soft deletion.
- [x] Deterministic schema-v11 day-record/occurrence transform and semantic validation.
- [x] Native Workers/D1 tests and repeatable staging E2E.
- [x] Temporary HomeMew day-record compatibility facade was retired from runtime and canonical contract.

### 2.6 Space-owned wishes

**Status: deployed and verified in staging on 2026-08-11; compatibility facade retired by Core 0.8.0 on 2026-08-11.**

- [x] Native Space-owned wishes with owner/claimant/fulfiller as same-Space Space People.
- [x] Preserve stable `wsh_*` IDs, optional date-only `desiredDate`, optimistic versions, audit snapshots and soft deletion.
- [x] Native CRUD plus claim/unclaim/fulfill/reopen/archive/restore with `wishes:read` / `wishes:write` scopes.
- [x] Preserve historical owner/claimant/fulfiller meaning after membership removal.
- [x] Deterministic schema-v11 Wish transform and lifecycle validation.
- [x] Native Workers/D1 tests and repeatable staging E2E on Core schema v7.
- [x] Temporary HomeMew Wish compatibility facade was retired from runtime and canonical contract.

## Native-only convergence / compatibility retirement

**Status: complete — Core 0.8.0 deployed and native staging smoke verified on 2026-08-11; PR #16 squash-merged to `main` as `651f42f8eaf154c78c9f20044e291edbbe5f9c26`.**

No D1 schema migration was required for this slice because the native tables and migration/audit mapping tables remain unchanged.

Completed scope:

- [x] Stop registering/authenticating `/api/v1/families...`, `/api/v1/family-invites...` and `/api/v1/me/families` in Core.
- [x] Delete the standalone HomeMew compatibility runtime router.
- [x] Remove legacy family/user mapping branches from Event, Task, Day Record and Wish request/response handling.
- [x] Make native person-reference fields (`attendeePersonIds`, `assigneePersonIds`, `subjectPersonId`, Wish Space Person refs) the only runtime model.
- [x] Publish canonical Core OpenAPI 0.8.0 with native paths/schemas only and contract checks rejecting retired paths or `Legacy*` schemas.
- [x] Replace legacy-first domain integration tests with native Space-domain lifecycle/boundary coverage and explicit retired-route `404` assertions.
- [x] Preserve `legacy_homemew_*` migration mapping tables and all HomeMew transform/validation scripts/tests as migration/audit artifacts.
- [x] Pass complete repository CI (`contract -> tests -> typecheck -> build`), including restored native boundary coverage.
- [x] Deploy Core 0.8.0 to staging and pass the repeatable native staging smoke without switching production/HomeMew traffic.
- [x] Confirm runtime Event/Task/Day Record/Wish/Core routing code no longer reads legacy mapping tables; remaining `legacy_homemew_*` usage is restricted to migration/audit schema and transform tooling.
- [x] Remove the unused `HOMEMEW_COMPAT_CLIENT_IDS` Wrangler/generated-binding configuration artifact while regenerating bindings in the profile/assets slice.

## User profile + R2 avatars/objects

**Status: complete — Identity 0.2.0 / schema v3 and Core 0.9.0 / schema v8 deployed and verified in staging on 2026-08-11 through PR #17. Production and HomeMew traffic remain unchanged.**

Completed scope:

- [x] Keep global user profile ownership in Identity; add authenticated `GET/PATCH /api/v1/me` with `profile:read` / `profile:write`.
- [x] Add Identity-owned user avatar metadata and `PUT /api/v1/me/avatar` with JPEG/PNG/WebP and 5 MB validation.
- [x] Keep Space avatar ownership in Core; add optimistic `PUT /api/v1/spaces/{spaceId}/avatar` protected by `spaces:manage` and current Space permission.
- [x] Keep raw R2 object keys private; expose stable public avatar read URLs through Identity/Core Worker routes.
- [x] Use one LifeSpace assets bucket per environment with service-owned namespaces: `avatars/users/...` for Identity and `avatars/spaces/...` for Core.
- [x] Preserve safe replacement semantics: write new object first, roll it back on DB/concurrency failure, and delete the old object only after metadata succeeds.
- [x] Add `avatarUrl` to native Space DTOs and Identity profile responses without exposing `avatar_key` as a public contract field.
- [x] Issue user JWTs for both `lifespace-core` and `lifespace-identity`; keep Core temporarily accepting the previous single-Core audience during issuer rollout.
- [x] Deploy Core verifier before the Identity issuer so the audience transition has no incompatible window.
- [x] Extend deterministic HomeMew migration tooling to populate native avatar metadata and emit `object-copy-manifest.json` with explicit legacy R2 source -> LifeSpace target mappings.
- [x] Validate avatar source ownership prefixes and reject invalid/cross-owner legacy keys rather than copying them silently.
- [x] Add Identity/Core Workers+D1+R2 integration coverage, contract checks, migration-transform tests and repeatable staging smoke for profile/user-avatar/Space-avatar behavior.
- [x] Keep production resources and HomeMew traffic untouched.

## Next slices

1. **External integrations / service authentication**
   - Implement service principals, opaque `lsp_pat_*` Service API Tokens, optional OAuth `client_credentials`, scopes and Data Grants according to `docs/service-authentication.md`.
   - Add HomeMew integration migration/report tooling, but do not reproduce `hmw_pat_*` as a LifeSpace credential format.

2. **Creation drafts / Queue**
   - Implement a native Space-aware workflow only if still required by the frozen HomeMew production capability set.
   - Queue messages and other ephemeral state are not migrated.

3. **Final native parity sweep**
   - Verify every production-used HomeMew capability has a deployed native replacement and deterministic migration/retirement decision.
   - Produce the exact native contract version HomeMew Phase 3 client migration will consume.

## Exit gate for Phase 2

Phase 2 is complete only when:

- Every production-used HomeMew backend capability has a tested and deployed native LifeSpace replacement.
- Every durable data set has a deterministic migration transform or explicit retirement decision.
- Required R2 object migration behavior is implemented and verifiable.
- Required service/integration authentication is implemented using the final LifeSpace model.
- Compatibility-only runtime routes and contract surfaces from Phase 2.2-2.6 have been removed from the target staging runtime.
- The canonical LifeSpace OpenAPI/contracts expose only implemented/deployed native functionality needed by the new HomeMew client.
- HomeMew can proceed to its native client migration without depending on any planned-only endpoint or HomeMew compatibility façade.
