# HomeMew Core -> LifeSpace Migration Plan

Updated: 2026-08-13

## 1. Goal

Migrate HomeMew's production-used shared backend capabilities into the **final** LifeSpace architecture, then adapt HomeMew clients, rehearse deterministic data/object migration, cut production over under a controlled write freeze, stabilize, and retire HomeMew's shared business Core.

LifeSpace is the sole source of truth for global Identity, Space/Data Grant authorization, shared business models, migrations, contracts and platform deployment configuration. HomeMew remains an application that owns UI, WeChat/provider identity mapping, app-specific Cloud Functions/BFF behavior and product-only policy.

Phase 2 proved native capability parity but HomeMew has not migrated any production traffic or durable data. Phase 3 replaced the Phase-2 handwritten-domain Core with the metadata-driven platform defined in `docs/phase3-metadata-platform-plan.md` and completed typed-storage/performance convergence before any HomeMew cutover.

## 2. Non-negotiable principles

- Migrate by capability, not by copying the HomeMew Worker wholesale.
- Native LifeSpace contracts use Space, membership, Space Person and Data Grant semantics.
- Do not add HomeMew `/api/v1/families/...` compatibility routes, legacy response façades or legacy token verification to the target platform.
- Keep deterministic migration mappings/transforms where IDs or models change; migration artifacts are not runtime compatibility APIs.
- External provider identities such as WeChat `openid` remain in the owning application adapter/BFF.
- Do not dual-write HomeMew D1 and LifeSpace D1 during normal migration. Use a controlled final write freeze.
- Every durable record has exactly one writable source of truth before and after cutover.
- Production and staging resources remain physically isolated.
- Secrets are re-provisioned/rotated, never copied through ordinary data export.
- Migration acceptance requires semantic, authorization and relationship verification, not only row counts.
- Keep HomeMew production Core operational until native client migration, full staging rehearsal and production cutover gates pass.
- HomeMew clients/data must target the final Phase-3 metadata-driven/typed-storage contract, never the discarded Phase-2 or intermediate JSON representation.

## 3. Final target runtime

```text
HomeMew Mini Program
  -> HomeMew WeChat adapter/Cloud Function resolves openid -> LifeSpace user_id
  -> trusted HomeMew backend exchanges through LifeSpace Identity
  -> short-lived HomeMew-app-scoped bearer token
  -> LifeSpace Core Generic Runtime / Capabilities

HomeMew Web/BFF
  -> same-origin HomeMew BFF
  -> LifeSpace Core / Identity using approved trusted boundaries

Owner-controlled n8n/script/MCP
  -> lsp_pat_* Service API Token
  -> LifeSpace Core

Third-party/policy-controlled service
  -> OAuth client_credentials
  -> short-lived service token
  -> LifeSpace Core
```

Production target services:

- `auth.aisr.online` -> LifeSpace Identity.
- `core.aisr.online` -> LifeSpace Core.
- HomeMew application domains remain HomeMew-owned.

There is no permanent production target where `homemew.aisr.online` or `/api/v1/families/...` is a façade over LifeSpace.

## 4. Migration classification

### Durable — migrate or explicitly retire

- LifeSpace users/profile metadata.
- Families -> Spaces.
- Memberships, Space People and valid invitations/history required by semantics.
- Events/attendees.
- Tasks/assignees.
- Day Records/occurrences.
- Wishes/lifecycle references.
- External integration definitions and non-secret audit mappings.
- Version, audit and deletion metadata required to preserve behavior.

Phase 5+ transforms target the final metadata-driven Resource/Capability schema, not discarded dedicated-domain or JSON storage.

### Object storage — copy and verify

- User avatars.
- Family/Space avatars.

Raw R2 keys are persistence details, never public contract fields.

### Ephemeral — do not data-migrate

- Queue messages in flight.
- AI Creation Draft jobs/results with short TTL.
- Rate-limit counters.
- Expired sessions/tokens.
- Rebuildable caches.

### Derived — recompute

- attention/countdown calculations;
- aggregate counts/statistics;
- rebuildable search/index/cache state.

### Secrets — re-provision/rotate

- JWT/OAuth signing keys;
- AI provider keys;
- Cloudflare tokens;
- WeChat secrets;
- application/service credentials.

Legacy `hmw_pat_*` plaintext and hashes are never migrated into LifeSpace credentials.

## 5. Core transformation principles

### Global users

HomeMew internal users map to global LifeSpace users. WeChat `openid` remains HomeMew application data and maps to LifeSpace `user_id` outside generic Core/Identity storage.

### Families -> Spaces

Each HomeMew family becomes a `Space(kind=family)` with explicit `family_id -> space_id` mapping. Family timezone is preserved. HomeMew-only product limits remain in HomeMew unless independently adopted as platform policy.

### Members -> Membership + Space Person

Authorization membership and represented household person remain distinct. Business relationships use Space Person IDs.

### Business domains -> final Model/Capability storage

HomeMew Event, Task, Day Record and Wish data transform directly into the final published Model Definitions plus Generic Runtime/Capability persistence determined by Phase 3.

Do not first import production data into Phase-2 dedicated tables or the discarded `resource_records.data_json` representation and then migrate it again.

### Data Grants

Do not manufacture broad Grants merely because source family membership existed. Membership provides approved in-Space authority; Grants represent explicit sharing/service access.

### External integrations

HomeMew system identities/family access become LifeSpace service principals + Data Grants. New `lsp_pat_*` or OAuth credentials are issued during controlled credential rotation; source credentials are not copied.

## 6. Phase status

| Phase | Status | Purpose |
| --- | --- | --- |
| Phase 0 | **Complete** | Baseline inventory, freeze rules and migration controls |
| Phase 1 | **Complete** | LifeSpace Identity/Core/Space/Grant foundation + staging infrastructure |
| Phase 2 | **Complete** | Native replacement/proof of every frozen production-used HomeMew backend capability |
| Phase 3 | **Complete** | Metadata-driven/AI-native runtime + typed storage + APAC performance convergence |
| Phase 4 | **In progress** | HomeMew native client/Cloud Function/integration adaptation to final contract |
| Phase 5 | Planned | Final-schema migration tooling and full staging data rehearsal |
| Phase 6 | Planned | Production cutover preparation |
| Phase 7 | Planned | Controlled production data cutover |
| Phase 8 | Planned | Stabilization and HomeMew Core cleanup |
| Phase 9 | Non-blocking | Post-cutover LifeSpace aggregation/sharing evolution |

## 7. Phase 0 — Baseline and migration controls

**Complete.** The production-used HomeMew baseline is frozen in `docs/homemew-parity-matrix.md` from HomeMew `main` commit `6ecdc7f3`. It covers 60 implemented operations in 13 capability groups. New released HomeMew backend capability may expand migration scope only through the freeze rule.

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

Phase-2 exit contracts were Core `0.11.0` / D1 v9 and Identity `0.3.0` / D1 v4. These are **historical Phase-2 exit contracts**, not the contract HomeMew will migrate to.

No HomeMew production traffic or durable data was switched to those contracts.

## 10. Phase 3 — Metadata-driven / AI-native platform

**Complete on 2026-08-13.** Normative implementation plan: `docs/phase3-metadata-platform-plan.md`; final evidence: `docs/phase3-status.md` and `docs/phase3-performance-convergence-plan.md`.

Phase 3 replaced handwritten ordinary-domain runtime with:

- Model Definition v1 and immutable/versioned Model Registry;
- isolate-memory Runtime Model Descriptor cache;
- deterministic Physical Schema Compiler;
- final `resource_records + mdl_<model_key> + resource_relations + Capability projections` storage;
- Generic CRUD/query/relation/concurrency/soft-delete runtime;
- current-state model authorization/Application × Model Access;
- safe Policy/Workflow engines;
- deterministic content-addressed model contracts;
- Calendar and Temporal reusable capabilities;
- Registry-driven Creation Draft / AI Interpretation;
- destructive cleanup of replaced Phase-2 and intermediate JSON/index persistence.

Final proving versions:

```text
Core Kernel Contract 0.12.0
Core D1 schema 24
Identity Contract 0.3.0
Identity D1 schema 4
```

The representative APAC performance gate passed on 2026-08-13 (Action run ID `31664559657`). Common read P50 measured **44–92 ms** and P90 **57–111 ms**, comfortably inside the Phase-3 target of P50 <= 220 ms and P90 <= 500 ms. D1 round-trip budgets are independently enforced in CI.

The Phase-3 migration blocker is therefore cleared.

## 11. Phase 4 — HomeMew native client migration to final contract

**In progress.** HomeMew becomes an ordinary LifeSpace application against the **post-Phase-3 generated contract** before any production data cutover.

### Contract pinning

The Phase-4 HomeMew staging release candidate is pinned to:

```text
Core Kernel Contract: 0.12.0
Model Contract:  mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Identity Contract: 0.4.0
Identity D1 schema: 4
```

The `mct_*` revision was observed consistently through the successful LifeSpace staging deployment's D1 pointer, authenticated HTTP verification and Registry-driven Creation Draft flow.

Identity 0.4.0 is a Phase-4 additive application-management contract: it adds trusted application metadata/policy inspection and `lsa_*` replacement/revocation lifecycle on the existing schema v4. Repository implementation/tests are complete; HomeMew must not depend on the 0.4.0 routes until the next explicit LifeSpace staging deployment verifies that contract.

HomeMew must never silently consume an unversioned latest contract. A later compatible Model Contract revision may be adopted only through an explicit pin update and downstream check.

### Mini Program / data layer

Application terminology may remain “家庭/成员”, while data-layer semantics use Space, membership, Space Person, generated model routes and final relation IDs.

Migrate all frozen flows:

- family/Space and membership management;
- invitations;
- profile/user avatar and Space avatar;
- Event/Task/Day Record/Wish flows through the final generated contract;
- Creation Draft enqueue/poll/model interpretation;
- external integration management.

### WeChat adapter

```text
Mini Program login
  -> HomeMew Cloud Function obtains trusted openid
  -> HomeMew mapping resolves openid -> LifeSpace user_id
  -> HomeMew backend authenticates to Identity with server-only lsa_*
  -> Identity issues HomeMew-app-scoped bearer token
  -> Mini Program calls LifeSpace Core
```

The Mini Program never submits an arbitrary `user_id` to obtain a token and never receives the `lsa_*` application credential.

Application credential lifecycle follows `docs/application-authentication.md`: inspect/update the `homemew-miniprogram` scope ceiling, create a replacement credential, install it in the backend secret store, verify the new backend deployment, then revoke the old credential.

### Phase 4 first implementation slice

1. inventory current HomeMew Mini Program/Cloud Function/Core coupling against the final LifeSpace Kernel + Model Contract;
2. pin the exact staging contract triple above;
3. deploy/verify Identity 0.4.0 in LifeSpace staging, inspect `homemew-miniprogram` policy and normalize it to the stable `resources:*` scope vocabulary if required;
4. create/install a staging-only replacement `lsa_*` application credential without exposing plaintext to Mini Program/client code or repository logs;
5. introduce staging-only LifeSpace client/auth configuration without switching production traffic;
6. adapt login/external identity exchange first, then Space/membership identity semantics;
7. migrate one proving ordinary model end-to-end (Task) before expanding to Wish/Day Record/Event;
8. keep existing HomeMew production Core as the active source until the complete Phase-4 exit gate passes.

Ordinary HomeMew user tokens should request only application-needed scopes such as `profile:*`, `spaces:*`, `resources:*` and `creation-drafts:*`. `models:manage` is a service-admin capability and must not be placed into Mini Program user tokens.

### Phase 4 exit gate

- release-candidate Mini Program/Cloud Functions run against the pinned LifeSpace staging APIs only;
- all frozen user/family/member/domain/integration/Creation Draft flows pass app E2E;
- login uses LifeSpace Identity-backed app-scoped tokens;
- trusted application credential is server-only, rotatable and old staging credential revocation has been verified;
- external integrations use LifeSpace credentials/Grants;
- no supported request depends on legacy HomeMew compatibility behavior;
- production HomeMew Core remains unchanged until an explicit later cutover decision.

## 12. Phase 5 — Final-schema migration tooling and full staging rehearsal

Version-controlled tooling must:

1. read HomeMew D1 export/snapshot;
2. create explicit identity/Space/Person/integration mappings;
3. transform durable domain data directly into the Phase-3 final Model/Capability schema;
4. import into a fresh target;
5. copy/verify required R2 objects;
6. generate machine-readable migration/credential-rotation reports;
7. run integrity, authorization and semantic verification.

Full rehearsal:

```text
recent HomeMew snapshot
  -> committed final-schema transforms
  -> fresh LifeSpace staging Identity/Core D1 + R2
  -> integrity/semantic/authorization verification
  -> HomeMew final native client E2E
```

Creation Draft historical jobs/messages remain intentionally absent because they are ephemeral.

### Phase 5 exit gate

- at least one clean full migration from recent snapshot into fresh staging target succeeds;
- reports explain expected count/ID transformations;
- integrity/authorization/semantic checks pass;
- native HomeMew client passes required E2E against migrated staging data.

## 13. Phase 6 — Production cutover preparation

Production cutover is permitted only after Phases 4 and 5 pass.

Required preconditions include production resource isolation, expected schema/contracts, current parity completeness, successful full rehearsal, committed migration/verification tooling, release-ready HomeMew client/Cloud Functions, verified WeChat mapping/token exchange, prepared integration credential/Grant switch and explicit rollback runbook.

## 14. Phase 7 — Controlled production data cutover

Use a controlled write freeze, not normal dual-write.

Sequence:

1. enter maintenance/write-freeze window;
2. stop HomeMew durable mutations/producers;
3. drain/terminate approved ephemeral work;
4. capture final HomeMew D1 export and R2 evidence;
5. record source schema/deployment/export metadata;
6. confirm clean LifeSpace production targets;
7. run committed final-schema transform/import and R2 verification;
8. run integrity/count/authorization/semantic verification;
9. rotate/activate integration credentials and Grants without duplicate delivery;
10. switch supported HomeMew configuration to LifeSpace production;
11. run critical client/integration smoke while writes remain frozen;
12. make go/no-go decision;
13. on GO enable LifeSpace writes/producers;
14. retain old HomeMew Core/D1 read-only during stabilization.

### Rollback before LifeSpace writes

On critical validation failure keep LifeSpace writes disabled, restore HomeMew routing/configuration and re-enable HomeMew writes. Because final export occurred during freeze, no production writes are lost.

### Rollback after LifeSpace writes

Do not blindly switch back to the pre-cutover HomeMew D1. Freeze LifeSpace writes first and account for every post-cutover mutation through an approved reverse/delta process; prefer forward-fixing LifeSpace where safe.

## 15. Phase 8 — Stabilization and HomeMew Core cleanup

During stabilization monitor Identity exchange, authorization, Generic Runtime/Capabilities, object access, Queue processing and integrations. Keep HomeMew Core/D1 read-only for the rollback evidence window.

After rollback closure:

- remove migrated shared business Core implementation from HomeMew;
- remove HomeMew ownership of shared D1 migrations/deploy workflows/resources;
- retain only required pinned/generated LifeSpace client/contract artifacts and application-specific adapters;
- retire obsolete HomeMew shared Core infrastructure after evidence retention requirements are met.

## 16. Phase 9 — Non-blocking platform evolution

After cutover, continue aggregation/sharing, additional reusable Capabilities, richer Policy/Workflow/trigger semantics and AI Admin UX without making those unrelated enhancements prerequisites for the completed HomeMew migration.
