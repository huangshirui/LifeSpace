# Phase 2 Status — HomeMew functional parity

Updated: 2026-08-10

Phase 2 is **in progress**. Phase 1 staging is the accepted platform baseline. The HomeMew production capability inventory is frozen in `docs/homemew-parity-matrix.md`.

## Phase 2 objective

Migrate current HomeMew shared backend capabilities into LifeSpace as complete Space-aware vertical slices while HomeMew production Core remains the writable baseline. No slice is complete with only CRUD: contract, D1 schema, authorization, migration transform, compatibility behavior, lifecycle coupling, and tests must move together.

## Completed in Phase 2

### Baseline and controls

- [x] Inventory the 60 implemented HomeMew OpenAPI operations.
- [x] Inventory D1 schema v11, R2, Queue, cron, rate-limit, secrets, and released Mini Program consumers.
- [x] Classify durable, object, ephemeral, derived, and secret state.
- [x] Record external integrations and credential continuity requirements.
- [x] Establish the Phase 2 freeze rule.
- [x] Define family -> family Space role, person, timezone, invitation, member-limit, and compatibility mappings.

## Family Space management

### 2.1 Native family Space policy

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Add an IANA `timezone` to the Space contract and persistence model.
- [x] Add Space update with optimistic concurrency.
- [x] Add member role update, member removal, and self-leave.
- [x] Enforce a family Space maximum of eight active members.
- [x] Enforce at least one active owner/admin.
- [x] Keep membership and the linked Space Person consistent.
- [x] Add Core-owned Space invitations with hashed tokens, one-time plaintext return, expiry, use count, revocation, preview, and atomic join/reactivation.
- [x] Add cross-Space, role, app-scope, stale-version, invite-race, last-admin, removal, and reactivation tests.
- [x] Update canonical OpenAPI and contract checks.

### 2.2 HomeMew compatibility

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Define explicit `fam_* -> spc_*` and member/person migration maps.
- [x] Implement temporary family-route compatibility over the same LifeSpace records.
- [x] Map `owner/admin -> admin` and `editor -> member` for legacy clients.
- [x] Preserve HomeMew family/member/invitation response fields, error classes, and the invitation-join `200` behavior required by released clients.
- [x] Keep HomeMew's maximum-three-created-families rule in the compatibility/application policy, not generic LifeSpace Space creation.
- [x] Add deterministic transform and validation tooling for users, families, memberships, Space People, invitations, and redemption history.
- [x] Verify the slice in staging without switching production traffic.

The compatibility mapping tables are transitional ID/audit metadata, not a second household store. Family records remain exclusively in native LifeSpace tables. The source creator becomes Space owner when still an active HomeMew administrator; otherwise the earliest active administrator is selected deterministically. The native owner role cannot be demoted through the legacy role endpoint. Historic duplicate invite-redemption pairs are collapsed into the native replay-safe relation and reported explicitly while the source invite `usedCount` is preserved.

Family avatar upload/copy remains in the later R2 object slice and is not included in the first membership/invitation acceptance claim.

## Events and attendees

### 2.3 Space-owned events and HomeMew compatibility

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Add one native `events` table owned by `space_id` and attendee relations to same-Space `space_person` records.
- [x] Preserve timed UTC instants with display timezones and half-open all-day date ranges.
- [x] Add native list/search/filter/create/read/update/delete routes with app scope × current Space permission enforcement.
- [x] Preserve HomeMew family event paths, `familyId`, attendee user IDs, response shapes, cursor filters and status codes through the compatibility facade.
- [x] Preserve optimistic concurrency, soft deletion, actor audit snapshots and stable `evt_*` IDs.
- [x] Add a deterministic schema-v11 event transform using the exact family mapping manifest from the same export.
- [x] Add D1, authorization, cross-Space, compatibility, pagination, time-semantic and transform tests.
- [x] Verify the slice in staging without switching production traffic.

Cross-Space `/api/v1/me/events` aggregation and calendar `free_busy` grants remain Phase 3 platform capabilities. They are not required to claim HomeMew event parity and are not exposed as planned-only endpoints in this slice.

## Tasks and assignees

### 2.4 Space-owned tasks and HomeMew compatibility

**Status: deployed and verified in staging on 2026-08-10.**

- [x] Add schema v5 `tasks` owned by `space_id` and `task_assignees` referencing same-Space `space_person` records.
- [x] Preserve `pending`, `completed` and `cancelled` lifecycle values, date-only `dueDate`, stable `tsk_*` IDs, optimistic versions, actor snapshots and soft deletion.
- [x] Add native list/search/filter/create/read/update/delete/complete/reopen routes with `tasks:read` / `tasks:write` app scopes intersected with current Space authorization.
- [x] Add temporary HomeMew family task paths over the same records, translating legacy assignee user IDs to Space Person IDs.
- [x] Preserve HomeMew search, assignee, due-date range, sorting, cursor and complete/reopen behavior; record the existing `includeNoDue` OpenAPI/runtime drift explicitly rather than silently changing it.
- [x] Add deterministic schema-v11 task transform using the exact family mapping manifest from the same export.
- [x] Add transform validation for lifecycle actors, same-family assignees and completion invariants.
- [x] Add Workers/D1 coverage for native/compatibility shapes, cross-Space assignee rejection, optimistic concurrency, completion/reopen, filtering/pagination, scopes, compatibility allowlist and soft deletion.
- [x] Update canonical Core OpenAPI to 0.5.0 and strengthen contract sanity checks.
- [x] Pass the complete repository CI after the 0.5.0 contract lands.
- [x] Apply D1 schema v5 to staging, deploy Core and run real staging Task E2E through the deployment smoke workflow.

The Task staging E2E verifies deployed Core schema/contract versions, `tasks:read` / `tasks:write` scopes, Space-owned task creation with a Space Person assignee, list/search/`me` filtering, unauthenticated denial, optimistic-concurrency conflict, complete/reopen/update lifecycle, `includeNoDue` semantics and soft deletion. The test is part of the repeatable `Deploy staging` workflow rather than a one-off manual probe.

The task compatibility route preserves the observed HomeMew runtime behavior where omitted `includeNoDue` evaluates to false even though the frozen HomeMew OpenAPI declared a default of true. Details are recorded in `docs/homemew-parity-matrix.md`.

## Active slice — Day records and occurrence history

### 2.5 Space-owned day records and HomeMew compatibility

**Status: implemented in draft PR #12; final CI and staging deployment/E2E pending.**

- [x] Freeze the released HomeMew day-record behavior from runtime code, D1 schema and integration tests.
- [x] Confirm the three discriminated kinds: `elapsed`, `countdown`, `cycle`.
- [x] Confirm Space/family timezone drives the date-only `today` used by computed state and occurrence validation.
- [x] Confirm non-countdown records maintain occurrence history; manual occurrences move the anchor forward atomically and recompute cycle due dates.
- [x] Confirm archived records are read-only for edits/occurrences but remain readable and restorable.
- [x] Confirm subject history must remain displayable after the represented member/Space Person is removed.
- [x] Add schema v6 Space-owned `day_records` and `day_record_occurrences` with same-Space subject enforcement.
- [x] Add native `/api/v1/spaces/{spaceId}/day-records` list/create/read/update/delete/archive/restore/occurrence routes using Space Person subject IDs.
- [x] Add temporary HomeMew family compatibility routes using legacy user subject IDs over the same records.
- [x] Preserve computed attention/state, date-only/timezone semantics, list/filter/sort/cursor, archive/restore, occurrence and optimistic-concurrency behavior.
- [x] Preserve historical subject display after membership/Space Person deactivation while requiring an active Person for new assignments/explicit subject filters.
- [x] Add deterministic schema-v11 day-record/occurrence transform and validation using the exact family mapping manifest from the same export.
- [x] Validate non-countdown occurrence history, current-anchor/latest-occurrence consistency, countdown no-history invariants, actor conversion, removed-member historical subjects and cycle `nextDueDate` consistency.
- [x] Update canonical Core OpenAPI to 0.6.0, package/status version and contract sanity checks, including composed-schema guards.
- [x] Add Workers/D1 integration and migration-transform tests for native/compatibility shapes, lifecycle, history, filters, scopes and cross-Space isolation.
- [x] Extend the repeatable staging smoke to require schema v6 / contract 0.6.0 and exercise Day-record creation, subject/list, occurrence advancement/history, stale-version rejection, archive/restore/update, authentication denial and soft deletion.
- [ ] Pass the final repository CI for the completed PR #12 head.
- [ ] Apply D1 schema v6 to staging, deploy Core and pass the real Day-record staging E2E after merge/authorization.

The Day-record persistence layer stores the subject as `subject_person_id` and enforces same-Space ownership. Unlike new assignment validation, historical reads intentionally do not require the referenced Person to remain active. This preserves the released HomeMew behavior where a record referring to a former family member still displays that historical subject after member removal.

Non-countdown migration history is treated as semantic data rather than optional audit decoration: the transform requires exactly one initial occurrence and requires the latest occurrence date to equal the record's current anchor. Countdown records reject occurrence history. This prevents a row-only migration from silently changing the meaning of elapsed/cycle records.

## Next slices

1. Wishes and lifecycle rules.
2. R2 avatars.
3. External integrations: service principals, direct opaque `lsp_pat_*` tokens for owner-controlled n8n/curl/scripts/MCP, optional OAuth `client_credentials`, scopes, Data Grants, and HomeMew credential migration.
4. Creation drafts/Queue if still required at parity freeze.
5. Any newly released HomeMew capability added under the freeze rule.

## Exit gate for Phase 2

Phase 2 is complete only when every production-used HomeMew capability has a tested LifeSpace replacement, compatibility path, migration transform, and staging verification result, and the HomeMew clients can proceed to the migration rehearsal without relying on undeployed or planned-only endpoints.
