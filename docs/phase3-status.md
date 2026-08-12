# Phase 3 Status — Metadata-driven Platform Runtime

Status: **repository implementation complete; staging exit pending**

Draft PR: #20 (`phase3-metadata-platform`)

HomeMew Phase 4 remains blocked until every staging exit gate below passes.

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

## Removed Phase-2 runtime

The final Core application no longer registers handwritten ordinary-domain routers.

Removed source implementations:

- `events.ts`
- `tasks.ts`
- `day-records.ts`
- `wishes.ts`
- fixed four-kind Creation Draft model/job/provider implementation

Historical Phase-2 migrations remain as audit evidence. Destructive staging convergence migrations remove the obsolete dedicated domain tables before HomeMew ever cuts over.

## Staging exit sequence

Run only against staging until all gates pass.

### 1. Repository gate

```bash
pnpm check
```

Must be green at the exact commit being deployed.

### 2. Apply Core D1 migrations

Apply staging migrations through schema **21** before deploying the new Core runtime.

The migration sequence is intentionally destructive for the obsolete Phase-2 domain tables because HomeMew never cut over durable production data to that intermediate runtime.

### 3. Deploy Identity/Core staging

Deploy the exact PR head to staging only.

Expected public Core status after deployment:

```json
{
  "service": "core",
  "schemaVersion": "21",
  "contractVersion": "0.12.0"
}
```

### 4. D1 convergence gate

Run:

```bash
node infra/scripts/verify-phase3-staging-db.mjs
```

After active Model Contract initialization, run the stricter form:

```bash
REQUIRE_ACTIVE_MODEL_CONTRACT=1 node infra/scripts/verify-phase3-staging-db.mjs
```

This verifies:

- schema v21;
- Task v2 / Wish v3 / Day Record v1 / Event v2 exact schema hashes;
- HomeMew Application × Model `write` catalog entries;
- required Generic/Temporal/Registry tables;
- absence of old dedicated Event/Task/Day/Wish tables;
- AI proposal columns and atomic audit trigger;
- active content-addressed `mct_*` when required.

### 5. Kernel/control-plane HTTP gate

Provide the already-created staging service-admin bearer to:

```bash
LIFESPACE_CORE_STAGING_URL=<core-staging-url> \
LIFESPACE_STAGING_MODEL_ADMIN_BEARER=<service-bearer> \
node infra/scripts/verify-phase3-staging-http.mjs
```

Optionally add a user bearer to prove the AI Model Admin user-principal denial boundary:

```bash
LIFESPACE_STAGING_USER_BEARER=<user-bearer>
```

This verifies:

- Kernel `0.12.0` / schema 21;
- published four-model Registry versions;
- active immutable Model Contract manifest;
- service-only AI Model Admin read boundary.

The script does not create credentials or duplicate staging bootstrap logic.

### 6. Existing infrastructure/auth gates

The existing staging bootstrap/deployment flow must still prove:

- Identity health/status;
- Core health/status;
- application credential authentication;
- opaque Service API Token behavior;
- OAuth/service principal behavior where configured;
- Data Grant authorization;
- Space avatar/R2 behavior;
- Queue availability and Creation Draft worker execution.

Any Phase-2 assertion in those scripts that expects Core `0.11.0`, schema 9, `events:*`/`tasks:*` scopes, handwritten domain tables or fixed `choose-kind` Creation Draft is obsolete and must be updated before the Phase-3 deploy workflow is considered authoritative.

### 7. Four-model semantic staging E2E

Using a disposable staging Space and current `resources:*` credentials, verify:

- Event: timed/all-day conversion rules, overlap window and attendee relation;
- Task: server default `pending`, complete/reopen Workflow and optimistic concurrency;
- Day Record: Temporal default/calculation, occurrence recording/history and archive/restore;
- Wish: owner/claim/fulfill/reopen/archive/restore Policy/Workflow, including removed claimant fallback;
- cross-Space Person relations are rejected;
- inactive historical Person references remain readable where required.

### 8. Registry-driven Creation Draft staging E2E

Verify:

- candidate models come from current writable Registry catalog;
- dynamic model descriptors/schema are used;
- `choose_model` can requeue;
- job exposes/pins `modelContractRevision`;
- contract change invalidates an old draft rather than interpreting it against new metadata;
- source input is removed after terminal states according to privacy rules.

### 9. AI Model Admin staging boundary

The Phase-3 exit does not require publishing a throwaway model through a paid/live AI provider if staging AI is intentionally unconfigured.

It does require:

- service-only proposal API is reachable;
- user principal is denied when a user bearer is available;
- unconfigured AI returns an explicit configuration error and does not change Model Registry state;
- repository tests for unsafe output, stale proposal, compatibility floor and atomic proposal audit remain green at the deployed commit.

If staging AI credentials are intentionally configured, one disposable proposal may additionally be generated and discarded; do not use a production model key.

## Phase 3 exit criteria

Phase 3 is complete only when all are true:

- exact deployed commit passes repository CI;
- staging Core reports Kernel 0.12.0 / D1 schema 21;
- D1 convergence checker passes;
- Kernel/control-plane checker passes;
- Identity/service-auth/Data Grant/R2/Queue gates pass;
- four proving models pass metadata-runtime semantic E2E;
- Registry-driven Creation Draft passes staging E2E;
- AI Model Admin security/control-plane boundary is verified;
- no production deployment occurs;
- no HomeMew client/data cutover occurs.

After this, PR #20 may be moved out of Draft and merged according to the agreed review/deployment process. HomeMew Phase 4 starts only after the Phase-3 closeout is recorded.
