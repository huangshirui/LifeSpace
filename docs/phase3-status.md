# Phase 3 Status — Metadata-driven Platform Runtime

Status: **repository implementation complete; base staging deployment passed; authenticated staging exit pending**

Draft PR: #20 (`phase3-metadata-platform`)

HomeMew Phase 4 remains blocked until the authenticated staging exit workflow passes at the exact PR head.

## Target invariant

> Adding an ordinary LifeSpace business model must not require modifying Core Runtime source code.

Phase 3 changes the unit of Core development from “one service/router/table per domain model” to reusable platform primitives:

```text
Kernel
  Identity-facing Principal boundary
  Space / Membership / Person
  Data Grant
  Model Registry / Model Admin
  Creation Draft orchestration

Generic Runtime
  schema validation
  declarative defaults
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
  future ordinary models
```

## Repository implementation

### Model platform

Implemented:

- closed Model Definition v1;
- model/field semantic descriptions;
- static server defaults;
- immutable published model versions;
- deterministic canonical schema hashes;
- explicit `initial | compatible | breaking` classification;
- Application × Model access catalog;
- stable `resources:read | resources:write | resources:manage` scopes;
- Generic Resource persistence, relation/index projections, CRUD and query;
- optimistic concurrency, soft deletion and actor audit.

Identity does not mint per-model token scopes. Effective ordinary-model authority is:

```text
verified principal
∩ stable resources:* credential scope
∩ Application × Model Access
∩ current Space membership/Data Grant
∩ published model capability
∩ model policy/Capability restrictions
```

Publishing a new ordinary model therefore does not require an Identity runtime or application-scope vocabulary change.

### Engines

Policy and Workflow use bounded declarative ASTs, not arbitrary code.

Workflow supports:

- state/value guards;
- actor/time/record references;
- deterministic field assignment;
- bounded conditional branches;
- bounded active-Person relation conditions.

This is sufficient for Task lifecycle and Wish lifecycle, including the Phase-2 removed-claimant restore fallback, without Wish-specific runtime code.

### Capabilities

Temporal owns elapsed/countdown/cycle semantics, Space-timezone date calculation, occurrence history, atomic advancement, attention/effective-date query and contract contribution.

Calendar owns timed/all-day normalization, IANA timezone labels, half-open overlap semantics, attendee relations, calendar sorting and contract contribution.

Capability code is registered platform code. Model metadata cannot name unknown capabilities or inject SQL/JavaScript/network calls.

### Model contracts

Core contracts are deliberately split:

```text
Kernel Contract
  apps/core/openapi.yaml
  Core 0.12.0

Model Contract Revision
  mct_<sha256>
  generated OpenAPI + JSON Schema from published Registry + Capability contributions
```

Ordinary model paths must never be copied into the Kernel OpenAPI. CI rejects Event/Task/Day Record/Wish or generic model route templates if they leak back into `apps/core/openapi.yaml`.

### Registry-driven Creation Draft

Creation Draft no longer contains a fixed union of Event/Task/Day Record/Wish.

At execution time Core derives the allowed model set from:

```text
published Model Registry
∩ requesting Application × Model write access
```

The job pins an immutable Model Contract Revision and rechecks current Application authorization before AI execution. Person relations use temporary refs and are resolved by Core; the AI never receives internal Person IDs.

### Guarded AI Model Admin

AI Model Admin is a proposal control plane, not publication authority:

```text
natural-language admin intent
  -> AI candidate Model Definition JSON
  -> Core parse + closed validation
  -> canonical schema hash
  -> deterministic diff / compatibility recommendation
  -> audited proposal
  -> explicit service-admin publish
  -> normal Model Registry publication
```

AI cannot execute DDL, SQL, JavaScript, shell commands, migrations, credential changes or model publication.

Invalid/unsafe output is retained only as a non-publishable `draft` with validation issues.

Publish rechecks:

- service principal + `models:manage`;
- current base model version;
- current Model Definition validator;
- stored schema hash;
- explicit compatibility;
- Core compatibility floor (`breaking` cannot be understated).

A publication claim prevents concurrent publish/discard. D1 schema v21 finalizes an exact claimed proposal in the same transaction as its matching authoritative `model_definitions` INSERT.

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

## Removed Phase-2 runtime

The final Core application no longer registers handwritten ordinary-domain routers.

Removed source implementations:

- `events.ts`
- `tasks.ts`
- `day-records.ts`
- `wishes.ts`
- fixed four-kind Creation Draft model/job/provider implementation

Historical Phase-2 migrations remain as audit evidence. Destructive staging convergence migrations remove the obsolete dedicated domain tables before HomeMew ever cuts over.

## Staging evidence already passed

On 2026-08-12 the general **Deploy staging** workflow succeeded on `phase3-metadata-platform` after being updated to the Phase-3 target.

Passed gates:

- repository `pnpm check`;
- Core migrations through schema 21;
- Core staging deployment;
- public Core `0.12.0 / schema 21` convergence;
- Identity migrations/deployment;
- public Identity `0.3.0 / schema 4` convergence;
- staging custom-domain verification;
- Phase-3 D1 convergence checker.

This proves the base staging runtime and infrastructure are converged. It does not by itself close Phase 3 because authenticated Model Contract/model/Queue gates remain.

## Authenticated staging exit workflow

The authoritative remaining gate is:

```text
Actions -> Phase 3 staging exit -> Run workflow
```

Default inputs:

```text
core_base_url = https://core-staging.aisr.online
deploy_core = false
```

`deploy_core=false` is appropriate when the exact Core runtime under test is already deployed. Set it to `true` only when the PR head contains a Core runtime/migration change that must be redeployed before verification.

The workflow is staging-only and refuses a non-staging Core URL.

### Ephemeral smoke bootstrap

`prepare-phase3-staging-smoke.mjs` creates one run-unique staging trusted application, user, short-lived user bearer, service principal and 15-minute maximum-lifetime service PAT.

The test application receives stable scopes only:

```text
profile:read
spaces:read
spaces:write
spaces:manage
resources:read
resources:write
creation-drafts:read
creation-drafts:write
models:manage
```

The user bearer intentionally carries `models:manage` as well so the HTTP gate proves that AI/Model Admin remains service-principal-only even when a user has the same scope string.

The staging bootstrap writes explicit `write` Application × Model catalog entries for Task/Wish/Day Record/Event directly to **staging Core D1 only**. This is test-fixture setup, not a production administration path.

Plaintext credentials are masked with GitHub `add-mask` and exported only through the current job's `GITHUB_ENV`. They are never written to repository files, artifacts or job summaries.

If staging signing keys or the Core↔Identity opaque-token introspection secret are missing/misaligned, the bootstrap repairs **staging only** and waits for verification convergence. It never targets production.

### Authenticated gates

The workflow then runs, in order:

1. `verify-phase3-staging-http.mjs`
   - Core Kernel 0.12.0 / schema 21;
   - exact four published model versions;
   - active immutable `mct_*` manifest;
   - service-only Model Admin / AI Model Admin boundary;
   - user principal denial even with `models:manage`.
2. `REQUIRE_ACTIVE_MODEL_CONTRACT=1 verify-phase3-staging-db.mjs`
   - active D1 Model Contract pointer/hash/revision.
3. `verify-phase3-staging-models.mjs`
   - Task defaults + complete/reopen Workflow;
   - Event Calendar interval/overlap/Person relation;
   - Day Record Temporal computation/occurrence history;
   - Wish Policy + claim/unclaim Workflow.
4. `verify-phase3-staging-creation-draft.mjs`
   - Registry-driven candidate set;
   - immutable Model Contract pin;
   - `choose_model` requeue when returned;
   - Queue/worker reaches a valid terminal state.

A live paid AI provider is not mandatory for Phase-3 closeout. When staging AI is intentionally unconfigured, a recognized explicit configuration failure is accepted only after the Queue/worker reaches the terminal state and the pinned contract behavior has been verified. Repository tests remain authoritative for unsafe AI output, stale proposal, compatibility floor and atomic proposal audit.

### Cleanup

An `always()` cleanup step:

- revokes the ephemeral service PAT when possible;
- disables the ephemeral service principal;
- removes the run-unique Application × Model catalog entries.

The service PAT also has a 15-minute maximum lifetime, so cleanup failure cannot create a long-lived model-admin credential.

Disposable staging user/application/Space audit fixtures may remain for traceability; they hold no plaintext credential in the repository and the removed catalog entries prevent the user bearer from retaining ordinary-model access after cleanup.

## Phase 3 exit criteria

Phase 3 is complete only when all are true:

- exact PR head passes repository CI;
- staging Core reports Kernel 0.12.0 / D1 schema 21;
- staging Identity reports 0.3.0 / D1 schema 4;
- D1 convergence checker passes;
- authenticated Kernel/control-plane checker passes;
- active immutable Model Contract checker passes;
- service authentication is exercised through a real staging service PAT;
- four proving models pass metadata-runtime semantic E2E;
- Registry-driven Creation Draft reaches a valid staging terminal state;
- AI Model Admin service-only boundary is verified;
- ephemeral staging authority cleanup is attempted;
- no production deployment occurs;
- no HomeMew client/data cutover occurs.

After this, PR #20 may be moved out of Draft and merged according to the agreed review/deployment process. HomeMew Phase 4 starts only after the Phase-3 closeout is recorded.
