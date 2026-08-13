# Phase 5 — HomeMew One-shot Migration Rehearsal

Status: **In progress**  
Started: 2026-08-13

## Objective

Prove that the current HomeMew durable data can be migrated once into the accepted final LifeSpace schema with a small, purpose-built migration script.

Phase 5 is deliberately not a reusable migration framework. Generic adapters, manifest frameworks, reusable report frameworks, dual-write, CDC, and incremental synchronization are out of scope.

Phase 5 does not modify the production HomeMew client, migrate production data, or deploy LifeSpace production.

## Accepted target contract

The one-shot script targets the Phase-4 accepted HomeMew integration tuple:

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity Contract:    0.4.0
Identity D1 schema:   4
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted
```

The script must refuse an incompatible HomeMew source schema or a different LifeSpace target contract.

## Actual work

Phase 5 has three implementation tasks.

### 1. One-shot migration script

Create one purpose-built script under `infra/migration/` that reads a HomeMew D1 export/snapshot as read-only input, validates the frozen HomeMew schema, maps users/families/members into LifeSpace users/Spaces/Memberships/Space People, migrates Event/Task/Day Record/Wish data directly into the accepted final LifeSpace schema, copies required avatar objects when present, excludes ephemeral/derived state, requires integrations to receive new LifeSpace credentials instead of copying legacy credentials, and verifies migrated counts/references before success.

The script may be specific to the frozen HomeMew schema and accepted LifeSpace contract. Generalization for future products is explicitly out of scope.

### 2. Single migration report

Each run emits one `migration-report.json` containing:

- source schema/version and snapshot checksum;
- source ID -> target ID mappings needed for diagnosis/audit;
- migrated counts for users, Spaces, people, Events, Tasks, Day Records, Wishes and objects;
- intentional omissions;
- integrations requiring credential re-provisioning;
- count/reference/object verification results;
- final `PASS` or `FAIL` result.

Separate inventory, mapping, integrity, semantic, object and credential-report frameworks are not required.

### 3. One staging rehearsal

Run the script once against a recent HomeMew production snapshot/export and a fresh isolated LifeSpace staging rehearsal target.

The rehearsal passes when every expected durable source record is migrated or explicitly explained, all migrated references resolve, representative HomeMew authorization and Event/Task/Day Record/Wish behavior remains correct, required objects are readable, and the final report result is `PASS`.

## Safety invariants

- HomeMew source access is read-only.
- Phase-5 commands reject LifeSpace production targets.
- Incompatible source schema, unresolved references and object mismatches are hard failures.
- Credentials are re-provisioned rather than copied from HomeMew.
- Partial success is failure; unresolved durable records must not be silently skipped.
- Staging and production resources remain isolated.

## Phase 5 deliverables

Only these deliverables are required:

1. one version-controlled HomeMew -> LifeSpace migration script;
2. one machine-readable `migration-report.json` format produced by that script;
3. one successful isolated staging rehearsal with evidence recorded in `docs/phase5-status.md`;
4. concise production execution notes sufficient to repeat the same script during Phase 7.

## Exit gate

Phase 5 is complete after one recent HomeMew snapshot is migrated successfully into a fresh isolated LifeSpace staging target and the resulting report/verifications pass. At that point Phase 4 + Phase 5 establish the HomeMew Integration Ready milestone.
