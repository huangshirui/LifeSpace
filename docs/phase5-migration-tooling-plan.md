# Phase 5 — HomeMew One-shot Migration Rehearsal

Status: **In progress — implementation complete, rehearsal pending**  
Started: 2026-08-13

## Objective

Prove once that the current operational HomeMew data can be moved into the accepted LifeSpace staging surface with one purpose-built script.

Phase 5 is deliberately not a reusable migration framework. Generic adapters, generic manifests/report systems, resume support, dual-write, CDC and incremental synchronization are out of scope.

## Accepted target

The script targets the accepted Phase-4 HomeMew integration tuple:

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity Contract:    0.4.0
Identity D1 schema:   4
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted
```

The implementation is pinned to the HomeMew schema/configuration and LifeSpace staging endpoints committed in the repositories. Live Identity/Core status must still report the expected staging contract/schema before target writes begin.

## Actual implementation

### One script

`infra/migration/homemew-one-shot.mjs` performs the whole rehearsal:

1. read HomeMew D1 with SELECT-only queries and require source schema `11`;
2. checksum the local snapshot;
3. validate that active source state can be represented by the accepted LifeSpace APIs;
4. create LifeSpace users, family Spaces, Memberships and Space People through native Identity/Core APIs;
5. migrate Event, Task, Day Record and Wish state/relations through the Generic Runtime and Capability actions;
6. copy avatars through the existing avatar APIs and verify bytes/digest;
7. record integration re-provisioning actions without copying old credentials;
8. verify created state and emit one `migration-report.json`.

Source IDs do not become target IDs. Each run records its own source-to-target mappings in the report.

### Current-state boundary

Phase 5 preserves **current operational application state**, not a byte-for-byte or audit-history clone of the old database.

Migrated:

- active users;
- active families and memberships;
- family creator -> `owner`, other `admin` -> `admin`, `member` -> `editor`;
- non-deleted Event/Task/Day Record/Wish records in active families;
- attendee/assignee/subject/wish relations converted to Space Person IDs;
- current lifecycle state;
- Day Record occurrence dates and manual notes that can be replayed through Temporal actions;
- current user/Space avatars;
- non-sensitive integration metadata needed to describe later re-provisioning.

Intentionally not imported:

- disabled users, archived families and removed memberships;
- invitation/redemption history;
- soft-deleted business records;
- Creation Draft jobs and transient OAuth state;
- legacy integration credentials;
- source record versions and historical audit timestamps/actors.

The script does not silently truncate or reinterpret incompatible active data. Unrepresentable active data is a hard failure before target mutation.

### One report

Each rehearsal emits one `migration-report.json` containing the source checksum, source-to-target mappings, migrated counts, intentional omission counts, integration re-provisioning actions, verification results and final `PASS`/`FAIL` state.

Generated snapshot/report files are git-ignored. The staging workflow uploads only the report, never the source snapshot.

## Branch rehearsal

The branch version of the existing `Deploy staging` workflow contains temporary Phase-5-only steps that run only for `phase5-one-shot-migration`:

1. complete the normal LifeSpace staging deployment and verification gates;
2. create a temporary credential for the accepted HomeMew staging application;
3. run `node infra/migration/homemew-one-shot.mjs rehearse`;
4. upload `migration-report.json`;
5. revoke the temporary application credential even if the rehearsal fails.

These workflow steps are temporary branch execution plumbing. They are removed after rehearsal evidence is captured so the normal staging workflow does not become a permanent migration mechanism.

## Safety invariants

- HomeMew D1 is never mutated by Phase 5.
- Target writes are staging-only and use normal LifeSpace APIs rather than direct target D1 writes.
- No source snapshot/user data is committed or uploaded as a workflow artifact.
- Old application/service credentials are not migrated.
- Schema/reference/semantic/object incompatibility fails the run.
- There is no production target, resume, dual-write, CDC or incremental catch-up behavior in Phase 5.

## Deliverables and exit gate

Phase 5 requires only:

1. the one-shot script;
2. one `migration-report.json` format;
3. one successful staging branch rehearsal with report `PASS`;
4. concise Phase-7 execution inputs recorded in `docs/phase5-status.md`.

Phase 5 completes when that rehearsal passes, representative current business state/relations verify, and the temporary staging credential is revoked. At that point Phase 4 + Phase 5 establish the HomeMew Integration Ready milestone.
