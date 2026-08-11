# Phase 2 Status — Native HomeMew capability migration

Updated: 2026-08-11

Phase 2 is **in progress**. Phase 1 staging is the accepted platform baseline. Phase 2.1-2.6 are deployed and verified in staging. After Phase 2.6, the migration direction was reset: LifeSpace no longer targets a HomeMew runtime compatibility layer; remaining work targets the final native LifeSpace architecture and HomeMew will adapt its clients to that contract.

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
- Remove compatibility-only runtime routes, OpenAPI surfaces, translation logic, allowlists and tests implemented in Phase 2.2-2.6 before production cutover.
- HomeMew-only product rules that are not platform invariants belong in the HomeMew application boundary.

This reset does **not** rewrite completed migration history. Phase 2.2-2.6 compatibility work was implemented and staging-verified under the previous plan; it is now classified as transitional code to retire rather than target architecture.

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

### 2.2 Family migration + transitional compatibility

**Status: deployed and verified in staging on 2026-08-10.**

Completed durable work that remains required:

- [x] Explicit `fam_* -> spc_*` and member/person migration maps.
- [x] Deterministic transforms and validation for users, families, memberships, Space People, invitations and redemption history.
- [x] Native Space records remain authoritative with no second family store.

Transitional work now being retired:

- [x] Temporary family-route compatibility was implemented under the previous plan.
- [x] Legacy role/field/status translation was implemented under the previous plan.
- [x] HomeMew compatibility-only three-created-family enforcement was implemented under the previous plan.

### 2.3 Space-owned events

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Native Space-owned `events` with same-Space Space Person attendees.
- [x] Timed UTC/display-timezone and half-open all-day semantics.
- [x] Native CRUD/search/filter/pagination with scope × Space authorization.
- [x] Stable `evt_*` IDs, optimistic concurrency, audit snapshots and soft deletion.
- [x] Deterministic schema-v11 event transform.
- [x] Native D1/authorization/time/pagination/transform tests and staging E2E.
- [x] Temporary HomeMew event compatibility facade was implemented under the previous plan and is now being retired.

### 2.4 Space-owned tasks

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Native Space-owned `tasks` and same-Space Person assignees.
- [x] Preserve pending/completed/cancelled lifecycle and date-only `dueDate`.
- [x] Native CRUD/complete/reopen routes with `tasks:read` / `tasks:write` scopes.
- [x] Stable `tsk_*` IDs, optimistic versions, actor snapshots and soft deletion.
- [x] Deterministic schema-v11 task transform and validation.
- [x] Native Workers/D1 tests and repeatable staging E2E.
- [x] Temporary HomeMew task compatibility facade was implemented under the previous plan and is now being retired; native `includeNoDue` omission remains explicitly `false`.

### 2.5 Space-owned day records

**Status: deployed and verified in staging on 2026-08-11.**

- [x] Native Space-owned day records and occurrence history.
- [x] Native `elapsed`, `countdown`, `cycle` discriminated semantics.
- [x] Space-timezone date-only computation and occurrence validation.
- [x] Same-Space Space Person subject model preserving historical subjects after deactivation.
- [x] Archive/restore, occurrence advancement, optimistic concurrency and soft deletion.
- [x] Deterministic schema-v11 day-record/occurrence transform and semantic validation.
- [x] Native Workers/D1 tests and repeatable staging E2E.
- [x] Temporary HomeMew day-record compatibility facade was implemented under the previous plan and is now being retired.

### 2.6 Space-owned wishes

**Status: deployed and verified in staging on 2026-08-11.**

- [x] Native Space-owned wishes with owner/claimant/fulfiller as same-Space Space People.
- [x] Preserve stable `wsh_*` IDs, optional date-only `desiredDate`, optimistic versions, audit snapshots and soft deletion.
- [x] Native CRUD plus claim/unclaim/fulfill/reopen/archive/restore with `wishes:read` / `wishes:write` scopes.
- [x] Preserve historical owner/claimant/fulfiller meaning after membership removal.
- [x] Deterministic schema-v11 Wish transform and lifecycle validation.
- [x] Native Workers/D1 tests and repeatable staging E2E on Core schema v7 / contract 0.7.0.
- [x] Temporary HomeMew Wish compatibility facade was implemented under the previous plan and is now being retired.

## Current slice — Native-only convergence / compatibility retirement

**Status: implementation in progress on branch `phase2-native-only-convergence`.**

Target contract version: **Core 0.8.0**. No D1 schema migration is required for this slice because the native tables and migration/audit mapping tables remain unchanged.

Implementation scope:

- [x] Stop registering/authenticating `/api/v1/families...`, `/api/v1/family-invites...` and `/api/v1/me/families` in Core.
- [x] Delete the standalone HomeMew compatibility runtime router.
- [x] Remove legacy family/user mapping branches from Event, Task, Day Record and Wish request/response handling.
- [x] Make native person-reference fields (`attendeePersonIds`, `assigneePersonIds`, `subjectPersonId`, Wish Space Person refs) the only runtime model.
- [x] Publish canonical Core OpenAPI 0.8.0 with native paths/schemas only and contract checks rejecting retired paths or `Legacy*` schemas.
- [x] Replace legacy-first domain integration tests with native Space-domain lifecycle coverage and explicit retired-route `404` assertions.
- [x] Preserve `legacy_homemew_*` migration mapping tables and all HomeMew transform/validation scripts/tests as migration/audit artifacts.
- [ ] Pass complete repository CI (`contract -> tests -> typecheck -> build`).
- [ ] Deploy Core 0.8.0 to staging and pass the repeatable native staging smoke without switching production/HomeMew traffic.
- [ ] Confirm no runtime code path reads legacy mapping tables after deployment.

## Next slices after convergence

1. **User profile + R2 avatars/objects**
   - Implement final Identity/Core ownership and object behavior required by HomeMew.
   - Add deterministic object/data migration and verification without adding HomeMew legacy routes.

2. **External integrations / service authentication**
   - Implement service principals, opaque `lsp_pat_*` Service API Tokens, optional OAuth `client_credentials`, scopes and Data Grants according to `docs/service-authentication.md`.
   - Add HomeMew integration migration/report tooling, but do not reproduce `hmw_pat_*` as a LifeSpace credential format.

3. **Creation drafts / Queue**
   - Implement a native Space-aware workflow only if still required by the frozen HomeMew production capability set.
   - Queue messages and other ephemeral state are not migrated.

4. **Final native parity sweep**
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
