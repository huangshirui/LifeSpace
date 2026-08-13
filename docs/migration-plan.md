# HomeMew Core -> LifeSpace Migration Plan

Updated: 2026-08-13

## 1. Goal

Prepare LifeSpace as the final shared platform that a redesigned HomeMew can integrate with directly, and prepare a deterministic **one-shot** migration path for HomeMew production data.

LifeSpace owns global Identity, Space/Data Grant authorization, shared business models, migrations, contracts and platform deployment configuration. HomeMew remains an application that owns its UI, WeChat/provider identity mapping, Cloudflare application backend/BFF behavior and product-only policy.

The redesigned HomeMew Mini Program and its Cloudflare backend are developed independently in the HomeMew project. They are **not** an intermediate step in this LifeSpace migration plan, and the existing WeChat Cloud Functions are not adapted to LifeSpace as a temporary bridge.

Phase 2 proved native capability parity without production cutover. Phase 3 replaced the handwritten-domain proving runtime with the final metadata-driven/typed-storage platform and completed APAC performance convergence. The remaining LifeSpace work is to become integration-ready and migration-ready for the future HomeMew release.

## 2. Non-negotiable principles

- Migrate by capability and final semantics, not by copying the HomeMew Worker wholesale.
- Native LifeSpace contracts use Space, Membership, Space Person and Data Grant semantics.
- Do not add HomeMew `/api/v1/families/...` compatibility routes, legacy response façades or legacy token verification to LifeSpace.
- Do not build or maintain a temporary `old HomeMew client -> LifeSpace` compatibility state.
- The redesigned HomeMew Mini Program/Cloudflare backend is developed separately and integrates directly with the final LifeSpace contract.
- External-provider identities such as WeChat `openid` remain in the owning HomeMew application backend, not LifeSpace Core/Identity.
- Do not dual-write HomeMew D1 and LifeSpace D1. Production data moves once, during a controlled final write freeze.
- Every durable record has exactly one writable source of truth before and after cutover.
- Production and staging resources remain physically isolated.
- Secrets are re-provisioned/rotated, never copied through ordinary data export.
- Migration acceptance requires semantic, authorization, relationship and object verification, not only row counts.
- HomeMew production Core remains operational until the redesigned HomeMew application is release-ready and the final production cutover begins.
- HomeMew data migrates directly into the final metadata-driven/typed-storage contract, never through discarded Phase-2 or intermediate JSON persistence.

## 3. Final target runtime

```text
HomeMew Mini Program
  -> HomeMew Cloudflare application backend resolves WeChat identity -> LifeSpace user_id
  -> trusted HomeMew backend exchanges through LifeSpace Identity
  -> short-lived HomeMew-app-scoped user token
  -> Mini Program / approved BFF path calls LifeSpace Core

HomeMew Web/BFF, when present
  -> same-origin HomeMew Cloudflare backend
  -> LifeSpace Core / Identity using approved trusted boundaries

Owner-controlled n8n/script/MCP
  -> lsp_pat_* Service API Token
  -> LifeSpace Core

Third-party/policy-controlled service
  -> OAuth client_credentials
  -> short-lived service token
  -> LifeSpace Core
```

Production target platform services:

- `auth.aisr.online` -> LifeSpace Identity;
- `core.aisr.online` -> LifeSpace Core;
- HomeMew application domains/backends remain HomeMew-owned.

There is no permanent target where `homemew.aisr.online` or `/api/v1/families/...` acts as a compatibility façade over LifeSpace.

## 4. Migration classification

### Durable — migrate or explicitly retire

- HomeMew users/profile metadata -> LifeSpace users;
- families -> Spaces;
- memberships and represented household people -> Membership + Space Person;
- invitations/history required by final semantics;
- Events/attendees;
- Tasks/assignees;
- Day Records/occurrences;
- Wishes/lifecycle references;
- external integration definitions and non-secret audit mappings;
- version, audit and deletion metadata required to preserve behavior.

Transforms target the final Model/Capability schema directly.

### Object storage — copy and verify

- user avatars;
- family/Space avatars.

Raw R2 keys are persistence details, never public contract fields.

### Ephemeral — do not migrate

- Queue messages in flight;
- AI Creation Draft jobs/results with short TTL;
- rate-limit counters;
- expired sessions/tokens;
- rebuildable caches.

### Derived — recompute

- attention/countdown calculations;
- aggregate counts/statistics;
- rebuildable search/index/cache state.

### Secrets — re-provision/rotate

- signing keys;
- AI provider keys;
- Cloudflare credentials;
- WeChat secrets;
- application/service credentials.

Legacy `hmw_pat_*` plaintext and hashes are never migrated into LifeSpace credentials.

## 5. Core transformation principles

### Global users

HomeMew internal users map deterministically to global LifeSpace users. WeChat `openid` remains HomeMew application data and maps to LifeSpace `user_id` in the future HomeMew Cloudflare backend.

### Families -> Spaces

Each HomeMew family becomes a `Space(kind=family)` with an explicit `family_id -> space_id` mapping. Family timezone is preserved. HomeMew-only product limits remain HomeMew policy unless independently adopted as platform policy.

### Members -> Membership + Space Person

Authorization membership and represented household person remain distinct. Business relations use Space Person IDs.

### Business domains -> final Model/Capability storage

HomeMew Event, Task, Day Record and Wish records transform directly into the final published Model Definitions plus Generic Runtime/Capability persistence produced by the Phase-3 architecture.

### Data Grants

Do not manufacture broad Grants merely because source family membership existed. Membership provides approved in-Space authority; Grants represent explicit sharing/service access.

### External integrations

HomeMew system identities/family access become LifeSpace service principals + Data Grants. New `lsp_pat_*` or OAuth credentials are issued during controlled credential rotation; source secrets are not copied.

## 6. Phase status

| Phase | Status | Purpose |
| --- | --- | --- |
| Phase 0 | **Complete** | Baseline inventory, freeze rules and migration controls |
| Phase 1 | **Complete** | LifeSpace Identity/Core/Space/Grant foundation + staging infrastructure |
| Phase 2 | **Complete** | Native replacement/proof of every frozen production-used HomeMew backend capability |
| Phase 3 | **Complete** | Metadata-driven/AI-native runtime + typed storage + APAC performance convergence |
| Phase 4 | **In progress** | **HomeMew Integration Readiness** — finish/freeze the LifeSpace platform surface HomeMew will consume |
| Phase 5 | Planned | **One-shot Migration Tooling & Rehearsal** — deterministic final-schema migration and staging rehearsal |
| Milestone | Planned | **HomeMew Integration Ready** — LifeSpace is ready for independent HomeMew development and a later one-shot cutover |
| Phase 6 | Planned | LifeSpace production platform bring-up with no HomeMew production data/traffic |
| Phase 7 | Planned | Controlled one-shot HomeMew production data migration and application cutover |
| Phase 8 | Planned | Stabilization and retirement of old HomeMew shared Core/infrastructure |
| Phase 9 | Non-blocking | Post-cutover LifeSpace aggregation/sharing evolution |

## 7. Phase 0 — Baseline and migration controls

**Complete.** The production-used HomeMew baseline is frozen in `docs/homemew-parity-matrix.md` from HomeMew commit `6ecdc7f3`. It covers 60 implemented operations in 13 capability groups. New released HomeMew backend capability may expand migration scope only through the freeze rule.

## 8. Phase 1 — Platform foundation

**Complete and staging verified.** Foundation includes independent Identity/Core Workers, global users/applications, trusted token exchange, RS256 tokens, Spaces/Memberships/Space People, roles/Data Grants, request envelopes/tracing, isolated staging resources, CI and deployment controls.

## 9. Phase 2 — Native capability parity proof

**Complete on 2026-08-11.** Detailed historical evidence remains in `docs/phase2-status.md` and `docs/homemew-parity-matrix.md`.

Completed capabilities include:

- family Space policy, membership, Space Person and invitations;
- Events + attendee semantics;
- Tasks + assignee/lifecycle semantics;
- Day Records + occurrence/temporal semantics;
- Wishes + lifecycle/person policy semantics;
- native-only convergence / compatibility retirement;
- Identity profile/user avatar + Core Space avatar/R2 behavior;
- service principals, Service API Tokens, OAuth `client_credentials`, Data Grants;
- native Creation Draft Queue, TTL/privacy/rate-limit behavior;
- deterministic transforms for the Phase-2 target and explicit ephemeral non-migration decisions.

Phase-2 exit contracts were Core `0.11.0` / D1 v9 and Identity `0.3.0` / D1 v4. These are historical proving contracts, not the contract future HomeMew will consume.

No HomeMew production traffic or durable data was switched to those contracts.

## 10. Phase 3 — Metadata-driven / AI-native platform

**Complete on 2026-08-13.** Normative implementation plan: `docs/phase3-metadata-platform-plan.md`; final evidence: `docs/phase3-status.md` and `docs/phase3-performance-convergence-plan.md`.

Phase 3 completed:

- Model Definition v1 and immutable/versioned Model Registry;
- isolate-memory Runtime Model Descriptor cache;
- deterministic Physical Schema Compiler;
- final `resource_records + mdl_<model_key> + resource_relations + Capability projections` persistence;
- Generic CRUD/query/relation/concurrency/soft-delete runtime;
- current-state model authorization/Application × Model Access;
- Policy/Workflow engines;
- deterministic content-addressed Model Contracts;
- Calendar and Temporal reusable capabilities;
- Registry-driven Creation Draft / AI Interpretation;
- destructive cleanup of replaced Phase-2 and intermediate JSON/index persistence.

Final Phase-3 proving baseline:

```text
Core Kernel Contract 0.12.0
Core D1 schema 24
Identity Contract 0.3.0
Identity D1 schema 4
```

The representative APAC performance gate passed on 2026-08-13 (Action run ID `31664559657`). Common read P50 measured **44–92 ms** and P90 **57–111 ms**, inside the Phase-3 targets of P50 <= 220 ms and P90 <= 500 ms. D1 round-trip budgets are independently enforced in CI.

The Phase-3 blocker is cleared.

## 11. Phase 4 — HomeMew Integration Readiness

**In progress.** This phase changes **LifeSpace only**. It does not migrate the existing HomeMew Mini Program or WeChat Cloud Functions.

The goal is to make the platform surface complete, stable and documented enough that the redesigned HomeMew Mini Program + Cloudflare backend can be developed independently against it.

### Current proving contract

The currently proven staging combination is:

```text
Core Kernel Contract: 0.12.0
Model Contract:  mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity repository contract: 0.4.0
Identity D1 schema: 4
```

The `mct_*` above is a **current proving revision**, not yet the permanent HomeMew release contract. Phase 4 may legitimately produce compatible contract revisions while integration gaps are closed. The exact HomeMew integration contract is frozen only at the **HomeMew Integration Ready** milestone.

Identity 0.4.0 adds generic trusted-application metadata/policy inspection and `lsa_*` replacement/revocation lifecycle on existing schema v4. This is retained as a platform capability; it is not a commitment to adapt the old HomeMew WeChat login Cloud Function.

### Required LifeSpace readiness work

Before Phase 4 can close, verify against the frozen HomeMew capability matrix that LifeSpace provides the final, app-independent platform behavior required for:

- global user/profile and avatar operations;
- family semantics represented through Space, Membership and Space Person;
- invitations;
- Space avatar/object behavior;
- Event + Calendar semantics;
- Task + Workflow semantics;
- Day Record + Temporal semantics;
- Wish policy/workflow semantics;
- Registry-driven Creation Draft / AI Interpretation;
- external service principals, credentials, Application × Model Access and Data Grants;
- all authorization and lifecycle behavior required by the frozen production baseline.

For the redesigned HomeMew application boundary, LifeSpace must document and prove:

- how a HomeMew Cloudflare backend authenticates to Identity after it has resolved WeChat identity to a LifeSpace user;
- how short-lived app-scoped user tokens are issued without ever trusting an arbitrary user ID from the Mini Program;
- which stable scopes and Application × Model Access entries HomeMew requires;
- which contract artifacts the HomeMew project must pin;
- whether Cloudflare Service Bindings are used as transport between same-account Workers and how application identity/authorization remains explicit rather than hostname-based.

No HomeMew application code is implemented in this phase.

### Phase 4 exit gate

- every frozen HomeMew backend capability required by the future application has a final native LifeSpace surface or an explicit approved retirement decision;
- final HomeMew-required authorization and trusted-backend boundaries are documented and staging-verified;
- Application × Model Access and stable user/service scope requirements are explicit;
- Kernel/Identity contracts and an accepted Model Contract revision are eligible to be frozen for HomeMew;
- generated/read-only contract artifacts can be handed to the HomeMew project;
- no exit criterion depends on modifying the old HomeMew Mini Program or WeChat Cloud Functions.

## 12. Phase 5 — One-shot Migration Tooling & Rehearsal

This phase also changes LifeSpace/migration tooling, not the production HomeMew client.

Version-controlled tooling must:

1. read a HomeMew D1 export/snapshot without mutating the source;
2. create deterministic HomeMew user -> LifeSpace user mappings;
3. create deterministic family -> Space and member -> Membership/Space Person mappings;
4. transform durable Event/Task/Day Record/Wish data directly into the final Model/Capability schema;
5. transform integration definitions into service-principal/Application × Model Access/Data Grant plans without copying source secrets;
6. copy and verify required R2 objects;
7. explicitly omit ephemeral data and recompute derived state;
8. generate machine-readable mapping, count, integrity and credential-rotation reports;
9. run authorization, relationship, semantic and object verification after import;
10. be safe to run against a fresh isolated target and fail closed on unresolved mappings or invariants.

### Full staging rehearsal

```text
recent HomeMew production snapshot/export
  -> committed deterministic transforms
  -> fresh/isolated LifeSpace staging rehearsal target
  -> final-schema import + R2 copy
  -> mapping/count/integrity/authorization/semantic verification
  -> migration report
```

The rehearsal proves the one-shot production procedure. It does **not** establish ongoing synchronization and does not make the rehearsal copy a second source of truth.

Creation Draft historical jobs/messages remain intentionally absent because they are ephemeral.

### Phase 5 exit gate

- at least one clean end-to-end migration rehearsal from a recent HomeMew snapshot succeeds;
- reports explain every expected count/ID transformation and every intentional omission;
- integrity, authorization, relationship, semantic and R2 verification pass;
- production migration tooling/runbook is deterministic and version controlled;
- no dual-write, CDC or incremental catch-up mechanism is required.

## 13. Milestone — HomeMew Integration Ready

This milestone is reached when **Phase 4 and Phase 5 both pass**.

It means:

> LifeSpace is ready for the redesigned HomeMew application to integrate, and a later HomeMew production cutover can migrate durable data once using the rehearsed procedure.

Milestone deliverables:

- frozen compatible Kernel + Identity contract versions for HomeMew;
- frozen accepted HomeMew Model Contract revision and reproducible contract/client artifacts;
- documented HomeMew Cloudflare trusted-backend/Identity boundary;
- explicit application scopes, Application × Model Access and integration credential rules;
- version-controlled one-shot data/R2 migration tooling;
- successful staging migration rehearsal and verification report;
- production provisioning/deployment runbook;
- production cutover and rollback runbook.

The milestone does **not** require the redesigned HomeMew Mini Program or Cloudflare backend to be finished. Their development proceeds independently in the HomeMew project after/alongside the platform handoff.

## 14. Phase 6 — LifeSpace production platform bring-up

After **HomeMew Integration Ready**, deploy the production LifeSpace platform before the HomeMew cutover day.

Bring up and verify isolated production resources:

```text
auth.aisr.online
core.aisr.online
production Identity/Core D1
production R2
production Queue/runtime secrets
production application/service registrations required for later HomeMew cutover
```

At this phase:

- do **not** migrate HomeMew durable production data;
- do **not** send HomeMew production traffic to LifeSpace;
- verify health/status, schema/contracts, signing/authentication, Registry/Model Contract, object/Queue bindings and representative empty-platform operations;
- create production credentials only through approved lifecycle procedures and store them in their final secret stores;
- keep staging and production physically isolated.

This intentionally separates first-time production provisioning from the later data migration/application cutover.

## 15. Independent HomeMew application development

The redesigned HomeMew Mini Program frontend and Cloudflare backend are outside this LifeSpace migration-plan phase sequence.

The HomeMew project consumes the frozen LifeSpace contract artifacts and develops directly against LifeSpace staging. It owns:

- WeChat login/provider exchange and `openid -> LifeSpace user_id` mapping;
- Cloudflare backend/BFF implementation and application secrets;
- Mini Program UI/data layer;
- client release/review/version-gating strategy;
- end-to-end application validation against LifeSpace staging.

There is no requirement to first migrate or adapt the old HomeMew WeChat Cloud Functions.

Production cutover cannot begin until the redesigned HomeMew release is ready and its staging E2E against the frozen LifeSpace contract has passed.

## 16. Phase 7 — Controlled one-shot production cutover

Use a controlled write freeze. There is no normal dual-write interval.

Preconditions:

- HomeMew Integration Ready milestone passed;
- empty LifeSpace production platform deployed and verified;
- redesigned HomeMew Mini Program + Cloudflare backend release-ready;
- redesigned HomeMew staging E2E passed against the frozen LifeSpace contracts;
- final source backup/export procedure and rollback decision points confirmed.

Sequence:

1. enter HomeMew maintenance/write-freeze window;
2. stop old HomeMew durable mutations/producers;
3. drain/terminate approved ephemeral work;
4. capture the **final** HomeMew D1 export and R2 evidence;
5. record source schema/deployment/export metadata;
6. confirm clean/expected LifeSpace production targets;
7. run the committed one-shot transform/import and R2 copy;
8. run mapping/count/integrity/authorization/relationship/semantic/object verification;
9. provision/activate new integration credentials and Grants without duplicate delivery;
10. activate the redesigned HomeMew configuration/release against LifeSpace production;
11. run critical application/integration smoke while writes remain frozen;
12. make the go/no-go decision;
13. on GO, enable LifeSpace-backed HomeMew writes/producers;
14. retain the old HomeMew Core/D1 read-only during stabilization.

The final production snapshot is migrated **once**. Any staging rehearsal data is disposable evidence and is not incrementally synchronized into production.

### Rollback before LifeSpace-backed writes

On critical validation failure, keep LifeSpace-backed HomeMew writes disabled, restore the old HomeMew application routing/configuration and re-enable old HomeMew writes. Because the final export occurred during the freeze, no production write is lost in this rollback case.

### Rollback after LifeSpace-backed writes

Do not blindly switch back to the pre-cutover HomeMew D1. Freeze LifeSpace-backed writes first and account for every post-cutover mutation through an approved reverse/delta process; prefer forward-fixing LifeSpace where safe.

## 17. Phase 8 — Stabilization and old HomeMew cleanup

During stabilization monitor Identity exchange, authorization, Generic Runtime/Capabilities, objects, Queue processing and integrations. Keep the old HomeMew Core/D1 read-only for the rollback evidence window.

After rollback closure:

- remove the old shared business Core implementation from HomeMew;
- retire obsolete HomeMew D1/Worker/shared infrastructure;
- retire obsolete WeChat Cloud Functions where the redesigned Cloudflare backend replaces them;
- retain only HomeMew application code, provider mapping, product policy and pinned/generated LifeSpace contract artifacts;
- retain migration evidence for the agreed audit/rollback period.

## 18. Phase 9 — Non-blocking platform evolution

After cutover, continue aggregation/sharing, additional reusable Capabilities, richer Policy/Workflow/trigger semantics and AI Admin UX without making unrelated enhancements prerequisites for HomeMew Integration Ready or the completed production cutover.
