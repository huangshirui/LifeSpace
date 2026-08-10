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

**Status: implemented on `agent/phase2-baseline`; pending repository CI and staging deployment.**

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

- [ ] Define explicit `fam_* -> spc_*` and member/person migration maps.
- [ ] Implement temporary family-route compatibility over the same LifeSpace records.
- [ ] Map `owner/admin -> admin` and `editor -> member` for legacy clients.
- [ ] Preserve HomeMew error and response behavior required by released clients.
- [ ] Keep HomeMew's maximum-three-created-families rule in the compatibility/application policy, not generic LifeSpace Space creation.
- [ ] Add transform and validation tooling for users, families, memberships, and invitations.
- [ ] Verify the slice in staging without switching production traffic.

Family avatar upload/copy remains in the later R2 object slice and is not included in the first membership/invitation acceptance claim.

## Next slices

1. Events and attendees.
2. Tasks and assignees.
3. Day records and occurrence history.
4. Wishes and lifecycle rules.
5. R2 avatars.
6. External integrations, credentials and scopes.
7. Creation drafts/Queue if still required at parity freeze.
8. Any newly released HomeMew capability added under the freeze rule.

## Exit gate for Phase 2

Phase 2 is complete only when every production-used HomeMew capability has a tested LifeSpace replacement, compatibility path, migration transform, and staging verification result, and the HomeMew clients can proceed to the migration rehearsal without relying on undeployed or planned-only endpoints.
