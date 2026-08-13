# Phase 5 — One-shot Migration Tooling & Rehearsal

Status: **In progress**  
Started: 2026-08-13

## Objective

Build and rehearse a deterministic, version-controlled, fail-closed procedure that migrates HomeMew durable production data exactly once into the final LifeSpace metadata-driven/typed-storage schema.

Phase 5 does not modify the production HomeMew client, does not introduce dual-write/CDC, and does not deploy LifeSpace production.

## Accepted target contract

Phase 5 targets the Phase-4 accepted HomeMew integration tuple:

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity Contract:    0.4.0
Identity D1 schema:   4
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted
```

A migration run must refuse to target a different contract tuple unless the migration specification is intentionally revised and re-reviewed.

## Workstreams

### 5.1 Source inventory and migration contract

- Pin the supported HomeMew source schema/migration baseline.
- Define durable, derived, ephemeral, object-storage and secret classifications.
- Define required source tables/columns and reject unknown/incompatible source schema versions.
- Produce a source inventory report before any target mutation.

Exit: a HomeMew snapshot can be inspected read-only and classified without importing data.

### 5.2 Deterministic identity and ownership mapping

- HomeMew users -> LifeSpace global users.
- families -> `Space(kind=family)`.
- members -> Membership + Space Person.
- Preserve an explicit machine-readable source ID -> target ID mapping.
- IDs are stable for the same source dataset and migration namespace; reruns on fresh targets produce identical plans.

Exit: all ownership/person references resolve or the plan fails closed.

### 5.3 Business-domain transforms

Transform directly into the final Phase-3 physical/runtime model:

- Event + attendees;
- Task + assignees/lifecycle;
- Day Record + occurrence semantics;
- Wish + lifecycle/person relations.

No Phase-2 handwritten tables and no intermediate JSON persistence may be used as a migration target.

Exit: generated import plans pass schema, relation, temporal and lifecycle validation.

### 5.4 Integrations and credentials

- Convert legacy integration definitions to service-principal/Application × Model Access/Data Grant plans.
- Never copy HomeMew `hmw_pat_*`, secret plaintext, secret hashes or provider secrets.
- Emit a credential-rotation/re-provisioning report for every integration that requires a new LifeSpace credential.

Exit: every source integration is either mapped with a rotation action or explicitly retired.

### 5.5 R2 objects

- Copy required user avatars and family/Space avatars.
- Verify source existence, target existence, byte length and digest when available.
- Treat object keys as persistence details, not public contract identifiers.

Exit: every required object is verified or migration fails.

### 5.6 Import and verification runner

The runner must execute against a fresh isolated target and separate planning from mutation:

1. inspect source;
2. create deterministic plan;
3. validate plan;
4. require explicit target/environment selection;
5. import Identity/Kernel ownership data;
6. import ordinary model/Capability data;
7. copy R2 objects;
8. verify counts, mappings, relationships, authorization, semantics and objects;
9. emit final immutable report bundle.

Partial success is failure. A failed run must leave enough audit information to diagnose the failure and must never silently skip unresolved records.

### 5.7 Staging rehearsal

Use a recent HomeMew production snapshot/export and a fresh isolated LifeSpace staging rehearsal target.

The rehearsal is successful only when:

- all expected durable rows are explained by import/mapping reports;
- every intentional omission is classified and counted;
- integrity and relationship verification passes;
- representative authorization checks pass;
- Event/Task/Day Record/Wish semantic checks pass;
- required R2 objects verify;
- credential-rotation actions are explicit;
- a second planning run over the same source produces the same deterministic plan/checksums.

## Safety invariants

- Source HomeMew snapshot access is read-only.
- No production target is supported by Phase-5 rehearsal commands.
- No dual-write, CDC or incremental synchronization is introduced.
- Secrets are never embedded in mapping or report artifacts.
- Unknown source schema, unresolved references, target contract mismatch and object mismatch are hard failures.
- Creation Draft jobs/messages, caches, sessions/tokens and other ephemeral state are intentionally excluded.
- Derived state is recomputed rather than copied.

## Version-controlled artifacts

Phase 5 owns:

- `packages/homemew-migration/` — deterministic planner/verifier library and CLI;
- fixtures containing synthetic HomeMew source data only;
- source/target manifest schemas;
- machine-readable mapping and verification report schemas;
- staging rehearsal workflow/runbook;
- `docs/phase5-status.md` — implementation and rehearsal evidence.

## Phase 5 exit gate

Phase 5 is complete only when all criteria in `docs/migration-plan.md` are satisfied, including at least one clean end-to-end staging rehearsal from a recent HomeMew snapshot. Until then, the HomeMew Integration Ready milestone is not reached.
