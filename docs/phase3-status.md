# Phase 3 Status — Metadata-driven Platform Runtime

Status: **technical implementation complete; authenticated staging exit passed**

Draft PR: #20 (`phase3-metadata-platform`)

Phase 3 has reached its technical exit criteria. HomeMew production/client cutover has **not** started and production LifeSpace resources were not touched.

## Target invariant

> Adding an ordinary LifeSpace business model must not require modifying Core Runtime source code.

The target runtime is now:

```text
Kernel
  Identity-facing Principal boundary
  Space / Membership / Person
  Data Grant
  Model Registry / Model Admin
  Creation Draft orchestration

Generic Runtime
  schema validation / defaults
  CRUD / query / cursor
  relation and index projections
  optimistic concurrency
  soft delete / actor audit

Generic Engines
  Policy
  Workflow

Capabilities
  Temporal / Cycle
  Calendar
  Registry-driven AI Interpretation
  Async Job / Queue

Model Definitions
  Task
  Wish
  Day Record
  Event
  future ordinary models without Core CRUD source changes
```

## Implemented platform behavior

Ordinary-model authorization is the intersection of:

```text
verified principal
∩ stable resources:* credential scope
∩ Application × Model Access
∩ current Space membership/Data Grant
∩ published model capability
∩ model policy/Capability restrictions
```

Identity does not mint one token-scope vocabulary per model. Publishing a new ordinary model therefore does not require an Identity runtime change; application access is governed by Core's Application × Model catalog.

Published Model Definitions are validated, immutable by version, schema-hashed and compatibility-classified. Generic Resource Runtime owns schema/default validation, CRUD/query, relation integrity, optimistic concurrency, soft deletion and actor audit. Policy and Workflow use bounded declarative ASTs rather than arbitrary code.

Core contracts are split into:

```text
Kernel Contract
  apps/core/openapi.yaml
  Core 0.12.0

Model Contract Revision
  mct_<sha256>
  generated OpenAPI + JSON Schema from Registry + Capability contributions
```

Registry-driven Creation Draft derives the writable model set from the published Registry intersected with current Application × Model access, and pins an immutable Model Contract Revision for queued execution.

AI Model Admin is a guarded proposal control plane only: AI may propose a Model Definition, but Core reparses it through the closed validator, computes deterministic diff/hash evidence, and requires explicit service-admin publication. AI has no DDL, SQL, JavaScript, shell, credential or autonomous publish authority.

## Current proving versions

| Model | Version | Runtime composition |
|---|---:|---|
| Task | 2 | Generic Runtime + Workflow |
| Wish | 3 | Generic Runtime + Policy + Workflow |
| Day Record | 1 | Generic Runtime + Temporal |
| Event | 2 | Generic Runtime + Calendar |

Core Kernel Contract: **0.12.0**  
Core D1 schema: **21**  
Identity Contract: **0.3.0**  
Identity D1 schema: **4**

The Phase-2 handwritten Event/Task/Day Record/Wish services and fixed four-kind Creation Draft implementation are removed from the target Core runtime. Historical migrations remain as audit evidence; destructive staging convergence removed the obsolete dedicated domain tables before any HomeMew durable-data cutover.

## Phase 3 staging exit evidence

Authoritative staging evidence:

- Workflow: **Deploy staging**
- Run: **#23**
- GitHub Actions run ID: `31561015721`
- Branch: `phase3-metadata-platform`
- Commit: `8a4d9fddb906a97bfa289a616f6469e69847f643`
- Date: **2026-08-12**
- Result: **success**

The successful run passed all of the following at the exact deployed commit:

1. repository `pnpm check`;
2. Core D1 migrations through schema 21;
3. Core staging deployment and public `0.12.0 / schema 21` convergence;
4. Identity migrations/deployment and public `0.3.0 / schema 4` convergence;
5. staging custom-domain verification;
6. Phase-3 D1 convergence checker;
7. ephemeral authenticated staging bootstrap;
8. authenticated Kernel / service-only Model Admin / AI Admin boundary verification;
9. active immutable `mct_*` Model Contract and D1 pointer verification;
10. Task defaults + complete/reopen Workflow;
11. Event Calendar interval/overlap/Person relation semantics;
12. Day Record Temporal computation and occurrence history;
13. Wish Policy deny/allow behavior with separate owner and claimant plus claim/unclaim Workflow;
14. Registry-driven Creation Draft Queue reaching a valid terminal state;
15. cleanup of ephemeral staging authority.

The Wish staging fixture explicitly proves both sides of policy enforcement: the owner cannot claim their own wish (`POLICY_DENIED`), while a distinct active Space member can claim and unclaim it.

The smoke bootstrap uses run-unique staging identities and a service PAT with a maximum 15-minute lifetime. Plaintext credentials are masked and kept only in the current Actions job environment. Cleanup revokes/disables ephemeral service authority and removes temporary Application × Model catalog entries.

## Phase 3 exit criteria

All technical exit criteria are now satisfied:

- [x] ordinary models can be added/published without handwritten Core CRUD source;
- [x] published model definitions are immutable/versioned/schema-hashed;
- [x] Generic Runtime enforces schema, relations, authorization, concurrency and soft deletion;
- [x] user/service authorization preserves current credential, Application × Model and Space/Data Grant boundaries;
- [x] generated model contracts are content-addressed and reproducible;
- [x] Task and Wish execute through Model Definition + Generic Engines;
- [x] Day Record executes through Temporal;
- [x] Event executes through Calendar;
- [x] Creation Draft is Registry-driven rather than fixed to four handwritten kinds;
- [x] Phase-2 handwritten ordinary-domain runtime is removed from the target Core;
- [x] Core/Identity/service-auth/model-contract/four-model/Queue staging gates passed;
- [x] AI Model Admin service-only security boundary was exercised in staging;
- [x] no production deployment occurred;
- [x] no HomeMew client or production-data cutover occurred.

## Next step

Phase 3 is technically ready for repository closeout. PR #20 may now be moved from Draft to Ready and squash-merged to `main` after explicit approval.

HomeMew Phase 4 / application migration should begin only from the merged Phase-3 baseline and must pin the new Kernel + Model Contract architecture rather than the discarded Phase-2 handwritten-domain contract.
