# HomeMew Core -> LifeSpace Migration Plan

Updated: 2026-08-11

## 1. Goal

Migrate HomeMew's production-used shared backend capabilities into LifeSpace while replacing HomeMew-specific ownership, identity and authorization assumptions with the final native LifeSpace platform model.

The target is **not** to make LifeSpace emulate HomeMew Core. The target is:

> Build and verify the native LifeSpace replacement, migrate HomeMew clients to that contract, rehearse deterministic data/object migration, cut production over under a controlled write freeze, stabilize, and then retire HomeMew's shared business Core.

LifeSpace is the sole source of truth for global Identity, Space/Data Grant authorization, shared domain models, migrations, contracts and platform deployment configuration. HomeMew remains an application that owns its UI, WeChat/provider identity mapping, app-specific Cloud Functions/BFF behavior and product-only policy.

## 2. Non-negotiable principles

- Migrate by capability, not by copying the HomeMew Worker wholesale.
- Native LifeSpace contracts use Space, membership, Space Person and Data Grant semantics.
- Do not add HomeMew `/api/v1/families/...` compatibility routes, legacy response façades or legacy HomeMew token verification to the target platform.
- Keep deterministic migration mappings/transforms where IDs or models change; migration artifacts are not runtime compatibility APIs.
- External provider identities such as WeChat `openid` remain in the owning application adapter/BFF.
- Do not dual-write HomeMew D1 and LifeSpace D1 during normal migration. Use a controlled final write freeze.
- Every durable record has exactly one writable source of truth before and after cutover.
- Production and staging resources remain physically isolated.
- Secrets are re-provisioned/rotated, never copied through ordinary data export.
- Migration acceptance requires semantic, authorization and relationship verification, not only row counts.
- Keep HomeMew production Core operational until native client migration, full staging rehearsal and production cutover gates pass.

## 3. Target runtime

```text
HomeMew Mini Program
  -> HomeMew WeChat adapter/Cloud Function resolves openid -> LifeSpace user_id
  -> trusted HomeMew backend exchanges through LifeSpace Identity
  -> short-lived HomeMew-app-scoped bearer token
  -> LifeSpace Core native API

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

At cutover, stop/drain producers or allow explicitly approved ephemeral work to expire/recreate.

### Derived — recompute

- Attention/countdown calculations.
- Aggregate counts/statistics.
- Rebuildable search/cache state.

### Secrets — re-provision/rotate

- JWT/OAuth signing keys.
- AI provider keys.
- Cloudflare tokens.
- WeChat secrets.
- application/service credentials.

Legacy `hmw_pat_*` plaintext and hashes are never migrated into LifeSpace credentials.

## 5. Core model transformation

### Global users

HomeMew internal users map to global LifeSpace users. Preserve IDs only where valid and collision-free; otherwise emit an explicit legacy-user -> LifeSpace-user mapping.

WeChat `openid` remains HomeMew application data and maps to the resulting LifeSpace `user_id` outside Core/Identity generic storage.

### Families -> Spaces

Each HomeMew family becomes a `Space(kind=family)` with explicit `family_id -> space_id` mapping. Family timezone is preserved.

HomeMew-only product policy such as a maximum number of created families stays in HomeMew unless independently adopted as a platform invariant.

### Members -> membership + Space Person

Authorization membership and represented household person are distinct. Domain relationships use Space Person IDs, including:

- Event attendees.
- Task assignees.
- Day Record subject.
- Wish owner/claimant/fulfiller.

### Data Grants

Do not manufacture broad Grants merely because source family membership existed. Membership provides the approved in-Space authority; Grants represent explicit sharing/service access.

### External integrations

HomeMew system identities/family access become LifeSpace service principals + Data Grants. New `lsp_pat_*` or OAuth credentials are issued during controlled credential rotation; source credentials are not copied.

## 6. Phase status

| Phase | Status | Purpose |
| --- | --- | --- |
| Phase 0 | **Complete** | Baseline inventory, freeze rules and migration controls |
| Phase 1 | **Complete** | LifeSpace Identity/Core/Space/Grant foundation + staging infrastructure |
| Phase 2 | **Complete** | Native replacement of every frozen production-used HomeMew backend capability |
| Phase 3 | **Next** | HomeMew native client/Cloud Function/integration adaptation |
| Phase 4 | Planned | Full migration tooling and staging data rehearsal |
| Phase 5 | Planned | Production cutover preparation |
| Phase 6 | Planned | Controlled production data cutover |
| Phase 7 | Planned | Stabilization and HomeMew Core cleanup |
| Phase 8 | Non-blocking | Post-cutover LifeSpace aggregation/sharing evolution |

## 7. Phase 0 — Baseline and migration controls

**Complete.** The production-used HomeMew baseline is frozen in `docs/homemew-parity-matrix.md` from HomeMew `main` commit `6ecdc7f3`.

The baseline covers 60 implemented operations grouped into 13 capability groups. New released HomeMew backend capability may expand migration scope only through the freeze rule in the parity matrix.

## 8. Phase 1 — LifeSpace platform foundation

**Complete and staging verified.**

Implemented foundation includes:

- independent Identity/Core Workers;
- global users and registered applications;
- trusted backend user/token exchange;
- RS256 token model and service boundaries;
- Spaces, memberships and Space People;
- roles, application scopes and Data Grants;
- request IDs, standard envelopes, health/status probes;
- canonical OpenAPI checks, Workers/D1 tests, TypeScript/build CI;
- environment-isolated staging D1/R2/Queue/secrets.

## 9. Phase 2 — Native HomeMew capability migration

**Complete on 2026-08-11.** Detailed evidence lives in `docs/phase2-status.md` and `docs/homemew-parity-matrix.md`.

### 9.1 Completed native capability set

- Family Space policy, memberships, Space People and invitations.
- Events + attendee Person semantics.
- Tasks + assignee Person semantics.
- Day Records + occurrence history.
- Wishes + lifecycle Person semantics.
- Compatibility retirement / native-only convergence.
- Identity-owned user profile/avatar + Core-owned Space avatar + deterministic R2 copy manifest.
- Service principals, `lsp_pat_*`, optional OAuth `client_credentials`, Data Grant management and HomeMew integration migration reports.
- Native Space Creation Draft / Queue workflow, 24-hour cleanup and AI rate-limit policy.
- Deterministic transforms for all durable baseline records and explicit non-migration decisions for ephemeral state.

### 9.2 Phase 2 exit contracts

HomeMew Phase 3 must pin:

- **Core `0.11.0`, D1 schema `v9`.**
- **Identity `0.3.0`, D1 schema `v4`.**

Core canonical contract contains only native LifeSpace paths for the migrated capability set. Compatibility-only HomeMew routes/schemas are absent.

### 9.3 Creation Draft decision

Creation Draft is retained because it is part of the released HomeMew client baseline.

Native behavior:

- `/api/v1/spaces/{spaceId}/creation-drafts...`.
- active user Space member only, with `creation-drafts:read/write`.
- service principals intentionally unsupported for this interactive flow.
- Space Person IDs in inferred domain relationships.
- Queue-backed retry-safe processing and choose-kind requeue.
- terminal input erasure, 24-hour TTL and hourly physical cleanup.
- HomeMew historical jobs, in-flight Queue messages and rate-limit counters are not migrated.

### 9.4 Phase 2 exit gate

- [x] Every frozen production-used backend capability has a tested native replacement.
- [x] All durable data has a deterministic transform or explicit retirement decision.
- [x] Avatar/object migration is deterministic and verifiable.
- [x] External integrations use the final service-principal/Data-Grant model.
- [x] Creation Draft has a native replacement and explicit ephemeral-state non-migration decision.
- [x] Target staging runtime has no required HomeMew compatibility API/token verifier.
- [x] Canonical contracts expose only implemented/deployed native functionality needed by HomeMew Phase 3.

## 10. Phase 3 — HomeMew native client migration

HomeMew becomes an ordinary LifeSpace application before any production data cutover.

### 10.1 Pin contracts

HomeMew must pin Core `0.11.0` and Identity `0.3.0`, or a later version only after an explicit compatibility review. It must never silently consume an unversioned latest contract.

Repository-local generated/read-only snapshots must be reproducible and not hand-edited.

### 10.2 Mini Program API/data-layer migration

Application code changes from HomeMew concepts to native identifiers/contracts:

```text
family              -> Space(kind=family)
familyId            -> spaceId
member              -> membership + Space Person
attendee/assignee   -> Space Person ID
Day Record subject  -> Space Person ID
Wish people         -> Space Person IDs
```

The UI may continue to display “家庭/成员”. No supported API request may depend on `/api/v1/families/...`.

Migrate all frozen client flows:

- family/Space and membership management;
- invitations;
- profile/user avatar and Space avatar;
- Event/Task/Day Record/Wish flows;
- Creation Draft enqueue/poll/choose-kind;
- external integration management.

### 10.3 WeChat identity adapter / Cloud Function

Keep WeChat-specific handling in HomeMew:

```text
Mini Program login
  -> HomeMew Cloud Function obtains trusted openid
  -> HomeMew mapping resolves openid -> LifeSpace user_id
  -> HomeMew backend authenticates to LifeSpace Identity
  -> Identity issues short-lived HomeMew-app-scoped bearer token
  -> Mini Program calls native LifeSpace Core
```

The Mini Program must never submit an arbitrary `user_id` to obtain a token.

### 10.4 External integrations

- HomeMew UI creates/manages LifeSpace service principals/credentials/Data Grants.
- Existing integrations receive newly issued LifeSpace credentials.
- HomeMew-only presentation/policy remains in HomeMew.
- Core remains the authority for scopes, membership, Grants and domain authorization.

### Phase 3 exit gate

- [ ] Release-candidate Mini Program and required Cloud Functions run against LifeSpace staging using native APIs only.
- [ ] All frozen family/member/profile/avatar/Event/Task/Day Record/Wish/integration/Creation Draft flows pass application E2E.
- [ ] Login produces LifeSpace Identity-backed HomeMew-app-scoped tokens.
- [ ] External integration UI/callers use LifeSpace credentials/Grants.
- [ ] No supported HomeMew request depends on a legacy LifeSpace compatibility route/token verifier.
- [ ] Unsupported old client versions and upgrade UX are explicitly understood.

## 11. Phase 4 — Migration tooling and full staging rehearsal

Do not use the final production target for the first full data transformation.

Version-controlled tooling must be able to:

1. read a HomeMew D1 export/snapshot;
2. create explicit ID mappings;
3. transform durable records to the current LifeSpace schema;
4. import into a fresh target;
5. copy/verify required R2 objects;
6. generate a machine-readable migration/credential-rotation report;
7. run integrity, authorization and semantic verification.

Required mapping artifacts include user mapping when changed, family -> Space, member -> membership/Space Person and integration -> service principal/non-secret credential metadata.

### Full rehearsal

```text
recent HomeMew snapshot
  -> committed migration tooling
  -> fresh LifeSpace staging Identity/Core D1 + R2
  -> integrity/semantic/authorization verification
  -> HomeMew native client E2E
```

Verify users, Spaces, memberships/People, Events, Tasks, Day Records, Wishes, avatars, integrations/Grants, cross-Space isolation, date/time semantics, pagination/search required by the client, optimistic concurrency and soft deletion.

Creation Draft historical jobs/messages are expected to be absent after migration because they are ephemeral.

### Phase 4 exit gate

- [ ] At least one clean full migration from a recent snapshot into a fresh staging target succeeds.
- [ ] Reports explain all expected count/ID transformations.
- [ ] Integrity, authorization and semantic checks pass.
- [ ] Native HomeMew client passes required E2E against migrated staging data.

## 12. Phase 5 — Production cutover preparation

Production cutover is permitted only after Phases 3 and 4 pass.

Preconditions:

- [ ] production Identity/Core Workers use production-only D1/R2/Queue/secrets;
- [ ] production status/smoke checks confirm expected schema/contracts;
- [ ] current parity matrix remains complete;
- [ ] full staging migration rehearsal succeeded from a fresh target;
- [ ] migration/verification tooling is committed/versioned;
- [ ] native HomeMew client and Cloud Functions are release-ready;
- [ ] WeChat mapping/token exchange is verified for production preparation;
- [ ] external integration credential/Grant switch procedure is prepared;
- [ ] unsupported legacy client handling is explicit;
- [ ] rollback decision points/runbook are documented.

## 13. Phase 6 — Production data cutover

Use a controlled write freeze, not normal dual-write.

Cutover sequence:

1. enter maintenance/write-freeze window;
2. reject/stop HomeMew Core mutations and durable producers;
3. drain or explicitly terminate in-flight writes/ephemeral Queue work;
4. capture final HomeMew D1 export and R2 inventory/evidence;
5. record source schema/deployment/export metadata;
6. confirm clean LifeSpace production targets at expected schema;
7. run committed transforms/import and R2 copy/verification;
8. run integrity/count/authorization/semantic verification;
9. rotate/activate new integration credentials and Grants without duplicate delivery;
10. switch supported HomeMew configuration to native LifeSpace production endpoints;
11. run critical HomeMew client/integration smoke while writes remain frozen;
12. make go/no-go decision;
13. if GO, enable LifeSpace writes and approved schedulers/producers;
14. keep old HomeMew Core/D1 read-only through stabilization.

Do not deploy a production legacy HomeMew API façade as part of cutover.

## 14. Rollback strategy

### Before LifeSpace writes are enabled

Prefer rollback on critical validation failure: keep LifeSpace writes disabled, restore HomeMew routing/configuration and re-enable HomeMew writes. Because the final export occurred during freeze, no production writes are lost.

### After LifeSpace writes are enabled

Do not blindly switch back to the pre-cutover HomeMew D1. Freeze LifeSpace writes first and account for every post-cutover durable mutation through an approved reverse/delta process. Prefer forward-fixing LifeSpace where safe.

The old HomeMew deployment is a temporary read-only rollback reference, not a writable split-brain peer.

## 15. Phase 7 — Stabilization and HomeMew Core cleanup

During stabilization:

- monitor Identity exchange, authorization, object access, Queue processing and integrations;
- keep HomeMew Core/D1 read-only for the rollback evidence window;
- fix native platform/client defects at their owning boundary rather than adding compatibility façades.

After rollback closure:

- [ ] remove migrated shared business Core implementation from HomeMew;
- [ ] remove HomeMew ownership of shared D1 migrations/deploy workflows/resources;
- [ ] keep only required pinned/generated LifeSpace contract snapshots in HomeMew;
- [ ] update HomeMew `AGENTS.md` to identify LifeSpace as platform/API source of truth;
- [ ] revoke legacy integration credentials;
- [ ] archive/delete obsolete HomeMew D1/R2/Queue only after backup/retention decisions.

## 16. Phase 8 — Post-cutover LifeSpace evolution

These are useful platform capabilities but are **not HomeMew migration blockers** unless a future supported HomeMew flow explicitly requires them:

- `/api/v1/me/events`, `/api/v1/me/tasks` and other cross-Space aggregates;
- source-Space/effective-permission metadata;
- cross-Space Data Grant reads without source duplication;
- read-only personal -> family sharing;
- calendar `free_busy` sharing;
- broader ALOHA cross-Space aggregation/sharing.

Sharing must preserve one source Space and current Grant revocation semantics.

## 17. Current implementation sequence

1. ~~Phase 2 native-only convergence~~ — complete.
2. ~~User profile + R2 objects~~ — complete.
3. ~~Service authentication/integration migration~~ — complete.
4. ~~Creation Draft / Queue~~ — complete.
5. ~~Final native parity sweep~~ — complete.
6. **Phase 3 HomeMew Mini Program/API client migration** — next.
7. Phase 3 WeChat identity adapter and integration-management migration.
8. Phase 3 full native HomeMew staging E2E.
9. Phase 4 full data migration rehearsal.
10. Phase 5 production preparation/runbook.
11. Phase 6 production cutover.
12. Phase 7 stabilization/cleanup.
13. Phase 8 non-blocking platform evolution.

## 18. Definition of HomeMew migration complete

The overall migration is complete only when:

- LifeSpace Identity is authoritative for migrated HomeMew global user/token flows;
- LifeSpace Core is the authoritative writable owner of migrated shared business data;
- supported HomeMew production capability is served through native LifeSpace APIs without HomeMew D1 reads/writes;
- production data/R2 migration passes repeatable verification;
- HomeMew Mini Program/Web/display and required integrations operate against pinned native LifeSpace contracts;
- WeChat/provider mapping remains correctly application-owned;
- old HomeMew Core is no longer a writable production source of truth;
- no legacy runtime compatibility façade/token verifier is required in LifeSpace;
- HomeMew repository no longer owns shared platform migrations/contracts/deployments.

After that, new shared domains are added to LifeSpace first and consumed by HomeMew, ALOHA or other vertical applications as clients.
