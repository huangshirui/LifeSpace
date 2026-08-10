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

## Active slice — family Space management

The first implementation slice is deliberately divided into independently verifiable steps.

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

## Active slice — Events and attendees

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

## Next slices

1. Tasks and assignees.
2. Day records and occurrence history.
3. Wishes and lifecycle rules.
4. R2 avatars.
5. External integrations: service principals, direct opaque `lsp_pat_*` tokens for owner-controlled n8n/curl/scripts/MCP, optional OAuth `client_credentials`, scopes, Data Grants, and HomeMew credential migration.
6. Creation drafts/Queue if still required at parity freeze.
7. Any newly released HomeMew capability added under the freeze rule.

## Exit gate for Phase 2

Phase 2 is complete only when every production-used HomeMew capability has a tested LifeSpace replacement, compatibility path, migration transform, and staging verification result, and the HomeMew clients can proceed to the migration rehearsal without relying on undeployed or planned-only endpoints.
