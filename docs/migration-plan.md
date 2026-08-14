# HomeMew Core -> LifeSpace Migration Plan

Updated: 2026-08-14

## 1. Goal

Prepare LifeSpace as the final shared platform that a redesigned HomeMew can integrate with directly, and provide a rehearsed **one-shot** migration path for HomeMew production data.

LifeSpace owns global Identity, Space/Data Grant authorization, shared business models, migrations, contracts and platform deployment configuration. HomeMew remains an application that owns its UI, WeChat/provider identity mapping, Cloudflare application backend/BFF behavior and product-only policy.

The redesigned HomeMew Mini Program and its Cloudflare backend are developed independently in the HomeMew project. They are **not** an intermediate step in this LifeSpace migration plan, and the existing WeChat Cloud Functions are not adapted to LifeSpace as a temporary bridge.

Phase 2 proved native capability parity without production cutover. Phase 3 replaced the handwritten-domain proving runtime with the final metadata-driven/typed-storage platform and completed APAC performance convergence. Phase 4 froze the application-facing LifeSpace surface and HomeMew integration boundary. Phase 5 then completed one real staging rehearsal of the deliberately small one-shot migration procedure.

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

Phase 5 intentionally converged on **current operational state**, not a complete historical/audit clone of the HomeMew database.

### Durable current state — migrate

- active HomeMew users/profile metadata -> LifeSpace users;
- active families -> Spaces;
- active memberships and represented household people -> Membership + Space Person;
- non-deleted Events/attendees;
- non-deleted Tasks/assignees and current lifecycle state;
- non-deleted Day Records/current occurrences required to represent current semantics;
- non-deleted Wishes/current lifecycle/person relations;
- non-sensitive external integration definitions needed to describe later re-provisioning.

Transforms target the final Model/Capability schema through normal LifeSpace APIs. Each migration run records its own source ID -> target ID mapping; different runs do not require identical generated target IDs.

### Historical/retired state — intentionally do not migrate

- disabled users, archived families and removed memberships;
- invitation/redemption history;
- soft-deleted business records;
- source record versions;
- historical audit timestamps/actors that are not expressible through the public final API.

If an **active** source record cannot be represented without changing its business meaning, migration fails instead of silently truncating or reinterpreting it.

### Object storage — copy and verify

- current user avatars;
- current family/Space avatars.

Raw R2 keys are persistence details, never public contract fields. Phase 5 copies objects through the existing avatar APIs and verifies byte length and SHA-256.

### Ephemeral — do not migrate

- Queue messages in flight;
- AI Creation Draft jobs/results with short TTL;
- rate-limit counters;
- expired sessions/tokens;
- transient OAuth state;
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

Legacy `hmw_pat_*` plaintext/hashes and other HomeMew credential material are never migrated into LifeSpace credentials.

## 5. Core transformation principles

### Global users

Each active HomeMew internal user is created/resolved as a global LifeSpace user during the migration run and recorded in that run's source-to-target mapping. WeChat `openid` remains HomeMew application data and maps to LifeSpace `user_id` in the HomeMew Cloudflare backend.

### Families -> Spaces

Each active HomeMew family becomes a `Space(kind=family)` and the run records `family_id -> space_id`. Family timezone is preserved. HomeMew-only product limits remain HomeMew policy unless independently adopted as platform policy.

### Members -> Membership + Space Person

Authorization membership and represented household person remain distinct. Business relations use Space Person IDs. HomeMew family creator maps to `owner`, other `admin` to `admin`, and ordinary `member` to `editor`.

### Business domains -> final Model/Capability storage

HomeMew Event, Task, Day Record and Wish state transforms directly into the final published Model Definitions plus Generic Runtime/Capability persistence produced by the Phase-3 architecture.

### Data Grants

Do not manufacture broad Grants merely because source family membership existed. Membership provides approved in-Space authority; Grants represent explicit sharing/service access.

### External integrations

HomeMew system identities/family access are recorded for later LifeSpace service-principal + Data Grant re-provisioning. New `lsp_pat_*` or OAuth credentials are issued during controlled credential rotation; source secrets are not copied.

## 6. Phase status

| Phase | Status | Purpose |
| --- | --- | --- |
| Phase 0 | **Complete** | Baseline inventory, freeze rules and migration controls |
| Phase 1 | **Complete** | LifeSpace Identity/Core/Space/Grant foundation + staging infrastructure |
| Phase 2 | **Complete** | Native replacement/proof of every frozen production-used HomeMew backend capability |
| Phase 3 | **Complete** | Metadata-driven/AI-native runtime + typed storage + APAC performance convergence |
| Phase 4 | **Complete** | **HomeMew Integration Readiness** — frozen LifeSpace application surface, trusted-backend boundary and reproducible handoff |
| Phase 5 | **Complete** | **One-shot Migration Rehearsal** — purpose-built script, consolidated report and real staging rehearsal |
| Milestone | **Complete** | **HomeMew Integration Ready** — Phase 4 + Phase 5 passed |
| Phase 6 | **Complete** | Empty isolated LifeSpace production platform deployed and verified; no HomeMew production data/traffic |
| Phase 7 | Planned | Controlled one-shot HomeMew production data migration and application cutover |
| Phase 8 | Planned | Stabilization and retirement of old HomeMew shared Core/infrastructure |
| Phase 9 | Non-blocking | Post-cutover LifeSpace aggregation/sharing evolution |

## 7. Phase 0 — Baseline and migration controls

**Complete.** The production-used HomeMew baseline is frozen in `docs/homemew-parity-matrix.md` from HomeMew commit `6ecdc7f3`. It covers 60 implemented operations in 13 capability groups. New released HomeMew backend capability may expand migration scope only through the freeze rule.

## 8. Phase 1 — Platform foundation

**Complete and staging verified.** Foundation includes independent Identity/Core Workers, global users/applications, trusted token exchange, RS256 tokens, Spaces/Memberships/Space People, roles/Data Grants, request envelopes/tracing, isolated staging resources, CI and deployment controls.

## 9. Phase 2 — Native capability parity proof

**Complete on 2026-08-11.** Detailed historical evidence remains in `docs/phase2-status.md` and `docs/homemew-parity-matrix.md`.

Completed capabilities include family Space/membership/Space Person/invitations, Events, Tasks, Day Records, Wishes, native-only convergence, Identity/Core avatars, service principals and service authentication, Data Grants, native Creation Draft Queue and explicit ephemeral non-migration decisions.

Phase-2 exit contracts were Core `0.11.0` / D1 v9 and Identity `0.3.0` / D1 v4. These are historical proving contracts, not the contract future HomeMew will consume. No HomeMew production traffic or durable data was switched to those contracts.

## 10. Phase 3 — Metadata-driven / AI-native platform

**Complete on 2026-08-13.** Normative implementation plan: `docs/phase3-metadata-platform-plan.md`; final evidence: `docs/phase3-status.md` and `docs/phase3-performance-convergence-plan.md`.

Phase 3 completed Model Definition/Registry, runtime descriptor caching, deterministic physical-schema compilation, typed storage, Generic CRUD/query/relation/concurrency/soft-delete runtime, current-state model authorization/Application × Model Access, Policy/Workflow engines, immutable Model Contracts, Calendar/Temporal capabilities, Registry-driven Creation Draft / AI Interpretation, and destructive cleanup of replaced intermediate persistence.

Final Phase-3 proving baseline:

```text
Core Kernel Contract 0.12.0
Core D1 schema 24
Identity Contract 0.3.0
Identity D1 schema 4
```

The representative APAC performance gate passed on 2026-08-13 (Action run ID `31664559657`). Common read P50 measured **44–92 ms** and P90 **57–111 ms**, inside the Phase-3 targets. D1 round-trip budgets are independently enforced in CI.

## 11. Phase 4 — HomeMew Integration Readiness

**Complete on 2026-08-13.** This phase changed **LifeSpace only**. It did not migrate the existing HomeMew Mini Program or WeChat Cloud Functions, move HomeMew durable data, deploy LifeSpace production or switch production traffic.

The accepted HomeMew contract tuple is:

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity Contract:    0.4.0
Identity D1 schema:   4
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted
```

The accepted HomeMew application boundary is:

- HomeMew Cloudflare backend owns WeChat/provider identity and `openid -> LifeSpace usr_*` mapping;
- server-only `lsa_*` authenticates the trusted backend to Identity;
- Identity issues a 900-second HomeMew-app-scoped user token after the backend resolves the authenticated user;
- Mini Program never receives `lsa_*` and cannot assert arbitrary LifeSpace user IDs;
- allowed HomeMew scopes are `profile:read/write`, `spaces:read/write/manage`, `resources:read/write` and `creation-drafts:read/write`;
- `models:manage` is excluded from HomeMew user tokens;
- Application × Model Access is `write` for Task, Wish, Day Record and Event;
- HTTPS/Service Binding is transport, not a replacement for explicit application authorization.

All frozen HomeMew backend capability groups were rechecked against the final metadata-driven runtime. No legacy `/families/...` route, legacy token acceptance, runtime user-ID-to-Person compatibility façade or additional HomeMew-specific Core runtime is required.

`packages/contracts` provides a reproducible/read-only HomeMew handoff exporter that pins the exact immutable `mct_*` rather than consuming active/latest contract state.

### Phase 4 staging evidence

- run #28 / `31692421666`: HomeMew application auth/scope/TTL/model-access boundary passed;
- run #29 / `31694445585`, commit `76499060dd736655b218b1a1e00902fb7d988682`: exporter-enabled full staging gate passed, including deterministic handoff export and artifact upload.

Detailed evidence and policy live in `docs/phase4-homemew-integration-readiness.md`.

### Phase 4 exit gate — passed

- every frozen HomeMew backend capability required by the future application has a final native LifeSpace surface;
- final HomeMew authorization and trusted-backend boundaries are documented and staging-verified;
- Application × Model Access and stable scope requirements are explicit;
- Kernel/Identity contracts and one immutable Model Contract revision are accepted;
- reproducible/read-only contract artifacts can be handed to HomeMew;
- production and HomeMew production traffic/data remain untouched.

## 12. Phase 5 — One-shot Migration Rehearsal

**Complete on 2026-08-13.** Phase 5 intentionally proved the specific HomeMew production migration path once instead of building a reusable migration framework.

The implementation is one purpose-built script at `infra/migration/homemew-one-shot.mjs`. It reads the frozen HomeMew D1 source with SELECT-only access, validates source/target compatibility, creates users/Spaces/Memberships/Space People through normal LifeSpace APIs, migrates Event/Task/Day Record/Wish state and relations, copies/verifies current avatars, records integration re-provisioning actions, and emits one consolidated `migration-report.json`.

Generic source adapters, manifest frameworks, separate report frameworks, reusable import-runner abstractions, deterministic target-ID generation across environments, dual-write, CDC, incremental catch-up and future-product migration generalization are explicitly out of scope.

### Full staging rehearsal — passed

`Deploy staging` run #30 / GitHub Actions run `31710955761`, rehearsal commit `bc42c1ed2b9e8fad05fe57c84dccfba677bdb7bb`, completed successfully.

`migration-report.json`: **PASS**.

Verified migration counts:

- 4 users;
- 3 family Spaces;
- 6 Memberships / 6 Space People;
- 461 Events;
- 20 Tasks;
- 4 Day Records;
- 5 Wishes;
- 490 business resources verified;
- 1 Day Record occurrence verified;
- 5 avatar objects verified by byte length and SHA-256.

The report explicitly accounted for intentional omissions in the source, including invitation/redemption history and soft-deleted records. Two active external-system definitions were recorded for later service-principal/Data Grant/new-credential re-provisioning; no legacy credential material was copied.

The temporary HomeMew staging application credential used by the rehearsal was revoked after the run, and the branch-only rehearsal workflow plumbing was removed after evidence capture.

Detailed evidence and Phase-7 execution inputs live in `docs/phase5-status.md`.

### Phase 5 exit gate — passed

- one clean end-to-end migration rehearsal from the current HomeMew source succeeded;
- every migrated current-state record was verified or every intentional omission was explicitly classified;
- required references, representative business semantics and avatar objects verified;
- `migration-report.json` recorded `PASS`;
- production execution inputs are sufficient to repeat the same one-shot procedure during Phase 7;
- no dual-write, CDC or incremental catch-up mechanism exists or is required.

## 13. Milestone — HomeMew Integration Ready

**Complete on 2026-08-13.** Phase 4 and Phase 5 have both passed.

It means:

> LifeSpace is ready for the redesigned HomeMew application to integrate, and a later HomeMew production cutover can migrate current durable state once using the rehearsed procedure.

Completed milestone deliverables:

- frozen compatible Kernel + Identity contract versions for HomeMew;
- frozen accepted HomeMew Model Contract revision and reproducible contract/client artifacts;
- documented HomeMew Cloudflare trusted-backend/Identity boundary;
- explicit application scopes, Application × Model Access and integration credential rules;
- version-controlled one-shot data/avatar migration script;
- successful staging migration rehearsal and PASS verification report;
- concise Phase-7 production migration/cutover inputs in this plan and `docs/phase5-status.md`.

The milestone does **not** require the redesigned HomeMew Mini Program or Cloudflare backend to be finished. Their development proceeds independently in the HomeMew project against the accepted LifeSpace contract.

## 14. Phase 6 — LifeSpace production platform bring-up

**Complete on 2026-08-14.** The empty, isolated LifeSpace production platform is deployed and verified before any HomeMew production migration or traffic cutover.

Accepted production deployment evidence:

```text
Deploy production run: 31776861588 / run #4
Accepted SHA:          52c988898ea2fbfaf95d7b35f43124c6580091f0
Identity:              auth.aisr.online / D1 schema 4 / contract 0.4.0
Core:                  core.aisr.online / D1 schema 24 / Kernel contract 0.12.0
Model Contract:        mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
R2:                    lifespace-assets
Queue:                 lifespace-creation-drafts
HomeMew application:   homemew-miniprogram
```

The production gate verified:

- exact production D1 identities and no staging resource reuse;
- production R2, Queue, Workers, custom domains and deployed bindings;
- `lifespace-core` Queue producer and Worker consumer attachment;
- production health/status convergence with exact schema/contract/environment values;
- RS256 signing material and Core↔Identity shared service-authentication secret presence/preservation;
- `lsp_pat_* -> Core -> Identity introspection` through a disposable Model Admin authority;
- the accepted active Model Contract and production proving models;
- HomeMew trusted-backend scope/TTL boundary, Identity JWT verification and Core JWT verification;
- explicit rejection of `models:manage` from the HomeMew application boundary;
- zero residual disposable probe authority;
- zero active HomeMew cutover credentials;
- final production business state `empty`.

No HomeMew production durable data migration was invoked and no HomeMew production traffic was sent to LifeSpace. The final HomeMew `lsa_*` credential was deliberately not issued. Detailed evidence lives in `docs/phase6-status.md`.

Phase 6 completion does **not** authorize Phase 7; it only removes first-time LifeSpace production provisioning from the later cutover risk envelope.

## 15. Independent HomeMew application development

The redesigned HomeMew Mini Program frontend and Cloudflare backend are outside this LifeSpace migration-plan phase sequence.

The HomeMew project consumes the accepted LifeSpace contract artifacts and develops directly against LifeSpace staging. It owns:

- WeChat login/provider exchange and `openid -> LifeSpace user_id` mapping;
- Cloudflare backend/BFF implementation and application secrets;
- Mini Program UI/data layer;
- client release/review/version-gating strategy;
- end-to-end application validation against LifeSpace staging.

There is no requirement to first migrate or adapt the old HomeMew WeChat Cloud Functions.

Production cutover cannot begin until the redesigned HomeMew release is ready and its staging E2E against the accepted LifeSpace contract has passed.

## 16. Phase 7 — Controlled one-shot production cutover

Use a controlled write freeze. There is no normal dual-write interval.

Preconditions:

- HomeMew Integration Ready milestone passed;
- empty LifeSpace production platform deployed and verified;
- redesigned HomeMew Mini Program + Cloudflare backend release-ready;
- redesigned HomeMew staging E2E passed against the frozen LifeSpace contracts;
- final source backup/read procedure and rollback decision points confirmed.

Sequence:

1. enter HomeMew maintenance/write-freeze window;
2. stop old HomeMew durable mutations/producers;
3. drain/terminate approved ephemeral work;
4. capture the **final** HomeMew source state using the same read-only migration input path rehearsed in Phase 5;
5. record source schema/deployment/snapshot metadata;
6. confirm clean/expected LifeSpace production targets;
7. run the committed one-shot migration against the explicitly selected production target;
8. require the resulting `migration-report.json` to pass mapping/count/reference/authorization/semantic/object verification;
9. provision/activate new integration credentials and Grants without copying old credentials or creating duplicate delivery;
10. activate the redesigned HomeMew configuration/release against LifeSpace production;
11. run critical application/integration smoke while writes remain frozen;
12. make the go/no-go decision;
13. on GO, enable LifeSpace-backed HomeMew writes/producers;
14. retain the old HomeMew Core/data read-only during stabilization.

The final production source state is migrated **once**. Staging rehearsal data is disposable evidence and is never incrementally synchronized into production.

### Rollback before LifeSpace-backed writes

On critical validation failure, keep LifeSpace-backed HomeMew writes disabled, restore old HomeMew application routing/configuration and re-enable old HomeMew writes. Because the final source capture occurred during the freeze, no production write is lost in this rollback case.

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
