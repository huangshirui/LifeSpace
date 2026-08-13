# Phase 5 Status

Updated: 2026-08-13

Status: **Complete — one-shot staging rehearsal passed**

## Goal

Migrate HomeMew once, not build a reusable migration platform.

Phase 5 delivers one purpose-built HomeMew -> LifeSpace migration script, one `migration-report.json`, and one successful staging rehearsal.

## Simplified scope

No generic migration adapters, reusable migration framework, multiple report frameworks, dual-write, CDC, incremental catch-up or future-product generalization are required.

The safety requirements remain: source read-only, staging-only rehearsal target, fail-closed compatibility/reference checks, target verification, and staging/production isolation.

## Implementation

- One migration program: `infra/migration/homemew-one-shot.mjs`.
- Source is pinned to the HomeMew schema/configuration committed in the HomeMew repository.
- Rehearsal target is pinned to the accepted Phase-4 LifeSpace staging contract/schema tuple.
- Source access is SELECT-only.
- Target creation uses existing LifeSpace Identity/Core APIs instead of direct target D1 writes.
- Each run records its own source ID -> target ID mappings; target IDs do not need to be identical between staging and production runs.
- HomeMew family creator -> LifeSpace `owner`; other `admin` -> `admin`; `member` -> `editor`.
- Event attendee, Task assignee, Day Record subject and Wish relations are converted to Space Person IDs.
- Task/Wish/Day Record state is replayed through native LifeSpace actions.
- Avatars are copied through existing avatar APIs and verified by byte length and SHA-256.
- Existing external integration definitions are recorded as re-provisioning actions rather than recreated with old credentials.
- Each run emits one report containing mappings, counts, intentional omissions, verification results and `PASS`/`FAIL`.
- Failed runs still write the report with mappings created before failure; there is no resume/incremental mode.
- Root CI syntax-checks the standalone script with `node --check`.
- Generated `.migration/*` files are git-ignored.

## Current-state boundary

The migration preserves **current operational application state**, not the old database's full audit/history representation.

Migrated:

- active users;
- active families and active memberships;
- non-deleted Event/Task/Day Record/Wish records in active families;
- current lifecycle state and Space Person relations;
- Day Record occurrence dates/manual notes that can be represented by the final Temporal capability;
- current user/Space avatars;
- non-sensitive integration metadata needed for later re-provisioning.

Intentionally not imported:

- inactive users/families/memberships;
- invitation/redemption history;
- soft-deleted business records;
- Creation Draft jobs and transient OAuth state;
- old credentials;
- source record versions and historical audit timestamps/actors.

If active source state cannot be represented by the accepted LifeSpace APIs without changing its business meaning, the script fails instead of silently truncating or rewriting it.

## Staging rehearsal evidence

`Deploy staging` run #30 / GitHub Actions run `31710955761` executed from rehearsal commit `bc42c1ed2b9e8fad05fe57c84dccfba677bdb7bb` and completed successfully.

`migration-report.json` result: **PASS**.

Verified migration counts:

- 4 users;
- 3 family Spaces;
- 6 Memberships and 6 Space People;
- 461 Events;
- 20 Tasks;
- 4 Day Records;
- 5 Wishes;
- 490 business resources verified;
- 1 Day Record occurrence verified;
- 5 avatar objects verified by byte length and SHA-256.

Intentional source omissions observed by the report included 1 family invite, 3 invite-redemption rows, 20 soft-deleted Events and 1 soft-deleted Task.

Two active external-system definitions were recorded for later LifeSpace service-principal/Data Grant/new-credential re-provisioning. No legacy credential plaintext/hash was migrated.

The temporary HomeMew staging application credential used by the rehearsal was revoked after the run. The temporary rehearsal workflow wiring was removed after evidence was captured.

## Phase 7 execution inputs

Production cutover reuses the same one-shot script after the Phase-6 production platform exists and the redesigned HomeMew release is ready.

During the final HomeMew write freeze:

1. capture the final HomeMew source state using read-only access;
2. run the one-shot migration against the explicitly selected LifeSpace production target using production-scoped credentials;
3. require `migration-report.json` to return `PASS` before enabling LifeSpace-backed HomeMew writes;
4. re-provision external integration credentials rather than copying legacy credentials;
5. retain the old HomeMew Core/data read-only during stabilization.

Production enablement/environment guards belong to Phase 7 and are not enabled by the Phase-5 rehearsal command.

## Safety result

- No HomeMew production client change.
- No HomeMew source data mutation.
- No LifeSpace production data/traffic mutation.
- No dual-write or CDC.
- No user snapshot committed or uploaded.
- Temporary rehearsal credential revoked.

## Exit gate

**Passed on 2026-08-13.**

Phase 4 + Phase 5 establish the **HomeMew Integration Ready** milestone.
