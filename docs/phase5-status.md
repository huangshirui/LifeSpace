# Phase 5 Status

Updated: 2026-08-13

Status: **In progress — script implemented, staging rehearsal pending**

## Goal

Migrate HomeMew once, not build a reusable migration platform.

Phase 5 delivers one purpose-built HomeMew -> LifeSpace migration script, one `migration-report.json`, and one staging rehearsal.

## Simplified scope

No generic migration adapters, reusable migration framework, multiple report frameworks, dual-write, CDC, incremental catch-up or future-product generalization are required.

The safety requirements remain: source read-only, staging-only target, fail-closed compatibility/reference checks, target verification, and staging/production isolation.

## Implemented

- Branch `phase5-one-shot-migration`, PR #24.
- Added the single migration program at `infra/migration/homemew-one-shot.mjs`.
- The source is pinned to the HomeMew schema/configuration already committed in the HomeMew repository.
- The target is pinned to the current LifeSpace staging Identity/Core endpoints and accepted Phase-4 contract/schema tuple.
- Source access is SELECT-only.
- Target creation uses existing LifeSpace Identity/Core APIs instead of direct target D1 writes.
- HomeMew family creator -> LifeSpace `owner`; other `admin` -> `admin`; `member` -> `editor`.
- Event attendee, Task assignee, Day Record subject and Wish relations are converted to Space Person IDs.
- Task/Wish/Day Record state is replayed through native LifeSpace actions.
- Avatars are copied through the existing avatar APIs and verified by byte length and digest.
- Existing external integration definitions are recorded as re-provisioning actions rather than recreated during the rehearsal.
- Each run emits one report containing ID mappings, counts, intentional omissions, verification results and `PASS`/`FAIL`.
- Failed runs still write the report with the mappings created before failure; there is no resume/incremental mode.
- Root CI syntax-checks the standalone script with `node --check`.
- Generated `.migration/*` files are git-ignored.

## Current-state boundary

The simplified migration preserves **current operational application state**, not the old database's full audit/history representation.

Migrated: active users, active families/memberships, non-deleted Event/Task/Day Record/Wish records in active families, current lifecycle state and Person relations, Day Record occurrence dates/manual notes, current avatar objects, and non-sensitive integration metadata needed for later re-provisioning.

Not imported: inactive users/families/memberships, invitation history, soft-deleted records, Creation Draft jobs, transient OAuth state, old credentials, source record versions, or historical audit timestamps/actors.

If active source state cannot be represented by the accepted LifeSpace APIs without changing its business meaning, the script fails before target mutation instead of silently truncating or rewriting it.

## Remaining work

1. run the script against the current HomeMew source using read-only access and LifeSpace staging;
2. inspect `migration-report.json` plus representative application semantics;
3. record the successful rehearsal evidence and concise Phase-7 execution steps here.

## Safety state

- No HomeMew production client change.
- No production data mutation.
- No production LifeSpace target write.
- No dual-write or CDC.
- No user data committed.

Phase 5 remains incomplete until the staging rehearsal passes.
