# HomeMew Core -> LifeSpace Migration Plan

## 1. Goal

Migrate HomeMew's proven shared backend capabilities into LifeSpace without breaking the current HomeMew applications, while replacing HomeMew-specific ownership and authorization assumptions with the LifeSpace platform model.

The migration target is **not** "finish every future LifeSpace domain before switching HomeMew". The target is:

> Build the LifeSpace platform foundation, reach functional parity for everything the current HomeMew production clients depend on, rehearse and verify data migration, cut traffic over safely, then retire HomeMew's business Core.

LifeSpace becomes the sole source of truth for Identity integration, Space/Data Grant authorization, shared business domains, migrations, contracts and platform infrastructure. HomeMew remains an application on top of LifeSpace.

## 2. Non-negotiable principles

- Migrate by capability, not by copying `apps/core` wholesale.
- Keep the current HomeMew Core operational until LifeSpace is deployed, verified and able to serve every required production capability.
- Do not make HomeMew depend on an undeployed or `planned` LifeSpace endpoint.
- Do not dual-write HomeMew D1 and LifeSpace D1 during normal migration. For this project size, a short controlled write-freeze cutover is safer than distributed dual-write consistency.
- Every durable business record has one source of truth before and after the cutover.
- Preserve business meaning, audit history and stable resource IDs where practical. Where a platform ID must change, use an explicit migration mapping rather than pretending two identity domains are the same.
- Separate global Identity concerns from Core Space/domain authorization. Identity and Core have separate service/data ownership.
- Production and staging resources remain physically isolated.
- Migration tooling must be repeatable and idempotent enough to run multiple staging rehearsals from a fresh target database.
- A migration is not accepted based only on row counts. Contract, authorization, relationships, domain semantics and representative API results must also be verified.
- Old HomeMew Core code, migrations and infrastructure ownership are removed only after the new platform is stable and rollback is no longer needed.

## 3. Target runtime during and after migration

```text
                           LifeSpace Identity
                         auth.aisr.online
                                |
                    token / SSO / app identity
                                |
                                v
ALOHA / HomeMew / vertical apps ---> LifeSpace Core
                                    core.aisr.online
                                          |
                           +--------------+-------------+
                           |              |             |
                         Core D1          R2          Queues

HomeMew Web browser
  -> same-origin HomeMew BFF
  -> Service Binding
  -> LifeSpace Core

HomeMew Mini Program
  -> short-lived app-scoped bearer token
  -> LifeSpace Core

Legacy HomeMew API hostname/path
  -> temporary compatibility route/alias
  -> the same LifeSpace Core
```

The old HomeMew Core remains available as the production baseline until cutover. It must not be modified into a partial LifeSpace implementation.

## 4. Migration scope and parity inventory

Before implementation begins, maintain a parity inventory of every HomeMew capability currently used by a released client or external integration.

Initial known capability groups include:

- Users and profiles.
- Families, memberships, invitations and administrator rules.
- Events and attendees.
- Tasks and assignees.
- Day records and occurrence history.
- Wishes and claim/fulfillment lifecycle.
- Anniversaries if implemented and consumed before the migration freeze.
- Avatars and other Core-owned R2 objects.
- External integrations, credentials and scopes.
- Search, pagination and cursor semantics.
- Optimistic concurrency and soft deletion.
- AI creation drafts / queue-backed interpretation if still used by HomeMew at cutover.
- Notifications, outbound webhooks and subscriptions that are implemented before the parity freeze.
- `/health`, `/api/v1/status`, schema version checks and request tracing.

This list is a starting point, not the final authority. Immediately before the parity phase is frozen, compare the current HomeMew OpenAPI, migrations, route registration, client calls and integration configuration. Any capability used by a released client becomes part of the required parity matrix.

Future LifeSpace domains such as goals, assets, health, credentials, growth and school records are **not blockers** for the HomeMew migration unless a HomeMew production client starts depending on them before cutover.

## 5. Data model transformation rules

### 5.1 Global users

HomeMew users become or map to global LifeSpace users.

Preferred rule:

- Preserve the existing user ID when it already satisfies LifeSpace global identity invariants and there is no collision or semantic conflict.
- Otherwise create a LifeSpace user ID and record an explicit `legacy HomeMew user -> LifeSpace user` mapping.
- ID preservation is a migration optimization, not a permanent platform guarantee.

External identity mappings such as WeChat `openid` remain owned by the application adapter/BFF that authenticates that provider. LifeSpace Identity only owns the resulting global LifeSpace user and trusted application credential/token issuance boundary; Core never stores provider IDs.

### 5.2 Families -> Spaces

Each HomeMew family becomes one LifeSpace Space with `kind=family`.

Do not silently reinterpret `fam_*` as a platform `spc_*` identifier. Prefer a new Space ID plus an explicit migration map:

```text
fam_xxx -> spc_xxx
```

Family settings that are truly Space-level settings may migrate to the Space. HomeMew-only presentation settings remain in the HomeMew application.

### 5.3 Family members -> Membership + Space Person

A HomeMew family membership becomes a LifeSpace Space membership for authorization.

Business subjects must remain distinct from login principals. Create/resolve a `space_person` for every represented family person required by domain relationships:

```text
space_person
- id
- space_id
- linked_user_id nullable
- display_name
- relationship/status as approved
```

For current HomeMew members that have login users, the migrated `space_person.linked_user_id` points at the migrated LifeSpace user.

Events, tasks, health/growth records and future person-subject domains should reference Space People where the relationship represents a person inside the Space, rather than assuming every represented person is an authenticated user.

### 5.4 Business records

Shared business records keep one source Space:

```text
events.family_id       -> events.space_id
tasks.family_id        -> tasks.space_id
day_records.family_id  -> day_records.space_id
wishes.family_id       -> wishes.space_id
...
```

Preserve stable business IDs such as `evt_*`, `tsk_*`, wish/day-record IDs and audit timestamps where practical. Preserve optimistic-concurrency versions unless a documented transformation requires a reset.

### 5.5 Data Grants

Do not infer broad cross-Space grants from existing family membership. Membership gives the approved default permission inside the migrated family Space.

Create Data Grants only for sharing semantics that genuinely exist or are explicitly introduced by the new architecture.

Cross-Space sharing never duplicates or moves the source record.

## 6. Data classification for migration

Classify every current HomeMew data set before writing migration code.

### Durable — must migrate or be explicitly retired

Examples:

- Users/profiles.
- Families/memberships/invitations that are still valid.
- Events, attendees, tasks and assignees.
- Day records and occurrence history.
- Wishes and lifecycle/audit references.
- Anniversaries or other implemented durable domains.
- External integration definitions.
- Credential metadata and hashes when the credential can remain valid safely.
- Webhook subscriptions and durable delivery configuration.
- Audit/version/deletion metadata needed to preserve behavior.

### Object storage — copy or deliberately preserve by reference

Examples:

- User/family avatars.
- Future attachments owned by Core.

When moving to a new R2 bucket, preserve object meaning and verify migrated object existence. Do not expose raw object keys as a public contract.

### Ephemeral — normally do not migrate

Examples:

- Queue messages in flight.
- Temporary AI creation-draft jobs/results whose lifecycle is intentionally short.
- Rate-limit state.
- Expired sessions and expired tokens.
- Local caches.

For cutover, drain or stop producers and document whether remaining ephemeral work is allowed to expire or must be re-created.

### Derived — recompute unless there is a reason to persist

Examples:

- Attention state.
- Computed countdown values.
- Aggregate counts/statistics.
- Search indexes or caches that can be deterministically rebuilt.

### Secrets — re-provision, do not copy through ordinary data export

Examples:

- JWT/OAuth signing keys.
- AI provider keys.
- Cloudflare API tokens.
- WeChat secrets.
- Service secrets.

Credential hashes stored as durable product data are different from deployment secrets and must be handled according to their credential contract.

## 7. Phase 0 — Baseline and migration controls

**Status: complete — the HomeMew production baseline is frozen in `docs/homemew-parity-matrix.md` on 2026-08-10.**

### Work

- [x] Establish LifeSpace repository and nested `AGENTS.md` hierarchy.
- [x] Record platform architecture, permission and contract principles.
- [x] Inventory all current HomeMew Core routes, OpenAPI operations, D1 migrations, R2 usage, Queues, crons, external integrations and Mini Program/Web callers.
- [x] Build the parity matrix with `HomeMew capability -> LifeSpace replacement -> compatibility requirement -> status`.
- [x] Identify all external systems and credentials that must survive cutover.
- [x] Record current production resource names and current schema version.
- [x] Define migration freeze rules: once parity implementation begins, any new HomeMew Core capability must also be reflected in this migration plan and LifeSpace parity matrix.

### Exit gate

- No unknown production-facing Core capability remains outside the parity inventory.
- Ownership of every current HomeMew data set is classified as durable, object, ephemeral, derived or secret.

## 8. Phase 1 — LifeSpace platform foundation

Build the platform pieces that every migrated domain depends on before porting event/task business routes.

**Status: complete — staging foundation deployed and end-to-end verified on 2026-08-10. Phase 2 may begin.**

### 8.1 Engineering/runtime foundation

- [x] Configure Hono + Cloudflare Worker runtime for `apps/core`.
- [x] Configure the Identity Worker runtime for `apps/identity`.
- [x] Add Wrangler configs with explicit staging and production separation.
- [x] Add Vitest/Cloudflare Workers test setup.
- [x] Add TypeScript configuration and Node.js 24/pnpm checks.
- [x] Add canonical success/error envelopes and `x-request-id` handling.
- [x] Add `/health` and `/api/v1/status` including schema/contract version diagnostics.
- [x] Add OpenAPI contract checks.
- [x] Add CI for `contract -> test -> typecheck -> build` before any deploy workflow.

### 8.2 Identity foundation

Define and implement the minimum global Identity model needed for HomeMew and future applications:

- [x] Global users.
- [x] Application-owned external identity mapping boundary and trusted backend exchange contract; provider IDs stay outside LifeSpace Core/Identity storage.
- [x] Registered applications/clients.
- [x] User/app/service/device principal vocabulary.
- [x] Short-lived Core access token issuance and verification contract.
- [x] Token `sub`, `iss`, `aud`, `client_id/azp`, scope, expiry and revocation rules.
- [x] Identity and Core signing/verification mechanism appropriate for separate services.
- [x] Web SSO/session model documented without shared parent-domain cookies; runtime browser SSO remains demand-driven.
- [x] Trusted backend token exchange primitive for Mini Program/application adapters; provider login and mapping remain application-owned.

Do not require ALOHA/HomeMew browser sessions to share a `.aisr.online` parent cookie.

### 8.3 Core ownership/authorization foundation

- [x] `spaces`.
- [x] `space_memberships`.
- [x] `space_people`.
- [x] Data Grant representation and evaluation.
- [x] Roles and default Space permission policy.
- [x] Application scopes independent from Data Grants.
- [x] Effective permission evaluation: current data authorization intersected with app scope.
- [x] `/api/v1/me` and `/api/v1/me/spaces` foundation.
- [x] Audit fields, ID generation, standard authorization errors and test helpers.

### 8.4 Staging infrastructure

Create isolated staging resources before production resources are used:

```text
auth-staging.aisr.online
core-staging.aisr.online
LifeSpace Identity staging D1
LifeSpace Core staging D1
staging R2 bucket(s)
staging Queue(s)
staging secrets
```

Never point staging Worker bindings at HomeMew production D1/R2/Queue resources.

### Phase 1 exit gate

The foundation is complete only when:

The Phase 1 gate was verified by the staging deployment smoke test: Identity and Core deployed independently, the runtime/schema status endpoints succeeded, a trusted staging application created a user, Identity issued an RS256 app-scoped token, Core accepted it to create/read a Space, and an unauthenticated request was denied. `pnpm check` passed before deployment.

- Identity and Core can deploy independently to staging.
- A test user can authenticate and obtain a valid app-scoped Core credential.
- Core can create/read a Space and membership and evaluate allow/deny cases.
- Data Grant and application-scope intersection is covered by tests.
- `/health` and `/api/v1/status` verify the expected runtime/schema bindings.
- CI passes contract, tests, typecheck and build.

Do not start bulk domain migration before this gate is satisfied.

## 9. Phase 2 — HomeMew capability migration to functional parity

**Status: in progress — baseline inventory frozen on 2026-08-10. Track execution in `docs/phase2-status.md` and capability coverage in `docs/homemew-parity-matrix.md`.**

Migrate shared domains incrementally. Each domain is one complete vertical slice: contract, schema, authorization, implementation, tests, migration transform and compatibility considerations.

Recommended order:

1. Family management -> family Space policy, memberships, invitations and Space People.
2. Events and attendees.
3. Tasks and assignees.
4. Day records and occurrence history.
5. Wishes and lifecycle rules.
6. Anniversaries if part of the released HomeMew contract by the parity freeze.
7. R2 avatar/object behavior.
8. External integrations, service principals, opaque Service API Tokens, optional OAuth `client_credentials`, Data Grants, and system scopes.
9. Webhooks/notifications that exist in the released Core.
10. AI creation drafts, Queue handling and related privacy/rate-limit behavior.
11. Remaining production-used HomeMew Core capability discovered in Phase 0.

### Family compatibility decision

The family slice uses persisted transitional maps for legacy users, families, memberships/Space People, and invitations. These maps translate released HomeMew paths and fields but do not hold an independent mutable family model. Native `spaces`, `space_memberships`, `space_people`, and `space_invites` remain authoritative.

The schema-v11 family transform preserves valid `usr_*` IDs, derives deterministic new `spc_*`, membership, and person IDs, and emits separate Identity/Core SQL plus a mapping manifest and verification report. An active creator/admin becomes owner; if the creator is no longer an active administrator, the earliest active administrator becomes owner. Removed memberships and people retain their deletion history. Duplicate historical redemptions of the same invite by the same user are collapsed into the native replay-safe relation and named in the report, while the source invite use count remains preserved.

Temporary HomeMew family routes require LifeSpace-issued, HomeMew-app-scoped credentials and current native authorization. They map `owner/admin -> admin` and `editor -> member`, reject `viewer`, keep invitation join at HTTP 200, and enforce the HomeMew three-created-family rule only for compatibility-created/migrated families. Family avatar values remain unavailable until the later R2 slice.

### Per-domain checklist

For every migrated domain:

- [ ] Define ownership (`space_id`) and subject (`space_person_id` where applicable).
- [ ] Define supported principals and required app scopes.
- [ ] Define Space role/Data Grant authorization.
- [ ] Port schema and indexes with important invariants enforced in D1.
- [ ] Preserve or explicitly transform version/deletion/audit behavior.
- [ ] Port UTC/date-only/timezone semantics without accidental changes.
- [ ] Port search/filter/sort/cursor semantics required by released clients.
- [ ] Define old HomeMew API compatibility behavior.
- [ ] Update canonical OpenAPI.
- [ ] Update contract checks.
- [ ] Add CRUD/state-transition tests.
- [ ] Add cross-Space isolation tests.
- [ ] Add user/system/service/device allow/deny tests as applicable.
- [ ] Add stale-version and deletion/history tests where applicable.
- [ ] Add a migration transform and validation for the domain.
- [ ] Record intentional differences from HomeMew.

Do not call a domain migrated if only its happy-path CRUD route works.

## 10. Phase 3 — Cross-Space aggregation and sharing

After basic HomeMew parity domains are stable, add the capabilities that justify LifeSpace as a shared platform rather than a renamed HomeMew Core.

### Work

- [ ] `/api/v1/me/events` across all currently accessible Spaces.
- [ ] `/api/v1/me/tasks` and other aggregate views when approved.
- [ ] Source-Space metadata and effective permission in aggregate responses where clients need it.
- [ ] Cross-Space Data Grant reads without copying source records.
- [ ] Read-only sharing from personal Space to family Space.
- [ ] Event `free_busy` sharing semantics if included in the first platform release.
- [ ] Tests proving a shared record remains owned by exactly one source Space.
- [ ] Tests proving a read-only grantee cannot mutate the source.
- [ ] Tests proving revoked grants stop access without waiting for a stale permission copy in a client.

### Exit gate

ALOHA/HomeMew can query authorized data through platform semantics without the client manually enumerating and merging every Space.

## 11. Phase 4 — Contract parity and compatibility layer

Before data migration, LifeSpace must be able to serve both the new platform contract and the released HomeMew clients that cannot all upgrade at once.

### Versioned platform contract

- [ ] Canonical Core OpenAPI is implemented, not merely `planned`.
- [ ] `packages/contracts` is reproducibly generated/versioned from canonical contracts.
- [ ] `packages/client` targets an explicit contract version.
- [ ] HomeMew pins a compatible LifeSpace contract/client version when it moves to the new APIs.

### Legacy HomeMew compatibility

For the Mini Program migration period, preserve the released API behavior needed by old versions, for example:

```text
/api/v1/families/{familyId}/events
/api/v1/families/{familyId}/tasks
...
```

The compatibility route may translate `familyId` through the migration mapping to a `kind=family` Space and then use the same LifeSpace domain implementation. It must not duplicate business data or maintain a second authorization engine.

Temporary compatibility may include:

- Existing HomeMew API paths.
- Existing response field names required by released clients.
- `homemew.aisr.online` as a temporary hostname alias to the LifeSpace Core Worker.
- A strictly time-bounded legacy token verification path during identity cutover if needed.

Compatibility code must be explicitly marked and removable. New applications must use the LifeSpace contract, not the legacy HomeMew façade.

### Exit gate

- Current released HomeMew Web/Mini Program behavior can run against LifeSpace staging without accessing HomeMew D1.
- New LifeSpace clients can use native Space and `/me` APIs.
- Compatibility behavior has tests and an explicit retirement condition.

## 12. Phase 5 — Migration tooling and rehearsal

Do not perform the first full transformation against the final production target.

### 12.1 Migration tooling

Build version-controlled tooling under the LifeSpace repository that can:

1. Read a HomeMew D1 export/snapshot.
2. Create migration maps for users/families/members as needed.
3. Transform records into the current LifeSpace schema.
4. Import into an empty LifeSpace target database.
5. Copy/verify required R2 objects when moving buckets.
6. Produce a machine-readable migration report.
7. Run integrity and parity verification.

The migration must be reproducible from a clean staging database. Do not rely on manual D1 edits for normal migration steps.

### 12.2 Required mapping artifacts

At minimum, persist migration-run mappings for:

```text
legacy_user_id   -> lifespace_user_id       when changed
family_id        -> space_id
family_member    -> space_membership
represented user -> space_person
legacy integration/credential IDs -> new IDs when changed
```

These mappings are migration artifacts and audit aids; they do not need to become public API models.

### 12.3 Rehearsal data migration

Use a recent HomeMew production snapshot or a production-like sanitized copy:

```text
HomeMew snapshot
  -> migration tool
  -> fresh LifeSpace staging D1/R2
  -> integrity checks
  -> API parity checks
  -> application smoke tests
```

Repeat until the migration is deterministic and the verification report is clean.

## 13. Migration verification requirements

### 13.1 Database-level verification

Compare relevant durable counts before/after transformation:

- Users.
- Families -> family Spaces.
- Memberships and Space People.
- Events/attendees.
- Tasks/assignees.
- Day records/occurrences.
- Wishes and lifecycle relations.
- Other parity domains.
- Integrations/credentials/subscriptions.

Counts do not need to be numerically identical for transformed structures such as member -> membership + Space Person, but the migration report must explain the expected relationship.

### 13.2 Referential-integrity verification

Verify at least:

- Every migrated business record references an existing Space.
- Every attendee/assignee/subject points at a valid Space Person in the same Space where required.
- Every linked Space Person user exists when `linked_user_id` is set.
- Every membership user exists.
- Every Data Grant has a valid principal/resource target.
- Historical actor references required by the domain are preserved.
- No active record references a deleted/invalid relation in a way that violates current LifeSpace rules.

### 13.3 Domain-semantic verification

For representative records, verify old and new behavior for:

- Timed event UTC ordering and timezone display metadata.
- All-day half-open date ranges.
- Task date-only due semantics.
- Search/filter/pagination behavior.
- Optimistic version conflicts.
- Soft-deleted record exclusion.
- Day-record computed state and occurrence history.
- Wish claim/fulfill/archive rules.
- Membership removal cleanup behavior.
- External-system scope enforcement.

### 13.4 API parity comparison

Build a comparison harness where practical:

```text
old HomeMew Core GET
      vs
LifeSpace compatibility/native GET
```

Normalize values that are intentionally different, such as:

- `requestId`.
- Platform metadata added only by LifeSpace.
- IDs explicitly remapped by the migration manifest.
- Canonical asset hostname when object storage moves.

Unexpected semantic differences fail the rehearsal.

### 13.5 Authorization matrix

Verify allow/deny behavior for:

- Space owner/admin/editor/viewer roles as implemented.
- Ordinary HomeMew family members after migration.
- Cross-Space isolation.
- Read-only Data Grants.
- Revoked grants.
- External systems/service identities.
- Device identities if the household display is migrated.
- App scope narrower than the user's Space permission.

## 14. Phase 6 — Production cutover preparation

The production cutover is permitted only after all prior gates pass.

### Required preconditions

- [ ] LifeSpace production Identity/Core Workers are deployed using production-only resources.
- [ ] Production D1/R2/Queue bindings are verified by `/api/v1/status` and smoke checks.
- [ ] Current HomeMew parity matrix is 100% complete for production-used capability.
- [ ] At least one full staging migration rehearsal succeeded from a fresh target.
- [ ] Migration and verification scripts are committed and versioned.
- [ ] HomeMew legacy API compatibility is deployed and tested.
- [ ] Mini Program identity/token transition is tested.
- [ ] External integration credentials/webhooks have an explicit migration procedure.
- [ ] Rollback decision points are written down before the maintenance window starts.

### Identity/token transition

Because released HomeMew clients may cache a short-lived Core token, do not switch Core verification assumptions blindly.

Preferred transition:

1. Update the trusted HomeMew login path/Cloud Function to obtain LifeSpace Identity-backed user tokens while keeping the client-facing login response compatible.
2. Verify new tokens against the still-compatible API path in staging/production preparation.
3. Allow the maximum legacy token TTL to expire before Core cutover where operationally practical.
4. If an overlap is unavoidable, LifeSpace may temporarily accept the legacy HomeMew issuer/audience under a narrowly scoped compatibility verifier with an explicit removal deadline.

Do not make permanent legacy-token acceptance part of the LifeSpace security model.

## 15. Phase 7 — Production data cutover

Use a controlled write-freeze instead of normal dual-write.

### Cutover sequence

1. Announce/enter the maintenance window for write operations.
2. Stop or reject new mutating HomeMew Core requests while keeping a clear maintenance response.
3. Stop/drain scheduled producers and Queue producers that can create durable writes.
4. Wait for or explicitly terminate in-flight write requests.
5. Create the final HomeMew D1 backup/export and required R2 inventory/snapshot evidence.
6. Record source schema version, export timestamp and source commit/deployment version.
7. Create/confirm a clean LifeSpace production target database at the expected schema version.
8. Run the committed migration transform/import.
9. Copy/verify required R2 objects.
10. Run database integrity checks.
11. Run migration report/count checks.
12. Run authorization checks.
13. Run representative API parity/smoke tests.
14. Verify external integration/webhook configuration without enabling duplicate delivery.
15. Route the compatibility hostname/path to LifeSpace Core or update the relevant backend/BFF configuration.
16. Verify HomeMew Web, Mini Program, household display and critical integrations against LifeSpace while writes are still frozen.
17. Make the go/no-go decision.
18. If GO, enable LifeSpace writes and resume approved schedulers/Queue producers.
19. Keep old HomeMew Core and its D1 read-only for the defined stabilization period.
20. Monitor errors, authorization denials, Queue failures, webhook duplication and application behavior.

Do not delete the old database or Core deployment during the cutover window.

## 16. Rollback strategy

### Before LifeSpace writes are enabled

Rollback is simple and should be preferred if any critical validation fails:

```text
LifeSpace validation fails
  -> keep LifeSpace writes disabled
  -> restore HomeMew routing
  -> re-enable HomeMew writes
  -> investigate and repeat migration later
```

Because HomeMew remained frozen during the final export, no production writes are lost.

### After LifeSpace writes are enabled

Do **not** blindly point users back to the pre-cutover HomeMew D1. That would lose writes accepted by LifeSpace after the cutover.

After write enablement:

- Prefer forward-fixing LifeSpace.
- For a true rollback, first freeze LifeSpace writes and account for every post-cutover durable mutation through an approved reverse/delta migration process.
- The old HomeMew Core remains useful as a reference/read-only fallback, not as an automatically writable split-brain peer.

This is another reason not to keep normal dual-write during migration.

## 17. Phase 8 — Client transition and compatibility retirement

### HomeMew Web

Move browser traffic to the HomeMew same-origin BFF and then to LifeSpace Core through Service Binding where practical. The browser should not need to know platform service credentials.

### HomeMew Mini Program

Old released versions may continue calling legacy HomeMew paths/hostname during the compatibility window. New versions should gradually move to the versioned LifeSpace contract and Space terminology where the product needs it.

Do not require every installed Mini Program version to update at the exact production data cutover moment.

### Household display

Move to a narrowly scoped read-only device identity/token. Do not migrate a household administrator's long-lived personal session into the display.

### ALOHA

ALOHA should integrate directly with native LifeSpace Identity/Core contracts and should not be built on the legacy HomeMew façade.

### External systems

Migrate n8n/Agents/other integrations to platform service/app identity and Data Grant semantics. Per `docs/service-authentication.md`, owner-controlled n8n, curl/scripts, scheduled jobs, and MCP servers should normally receive a new opaque `lsp_pat_*` Service API Token and continue making one direct Bearer-authenticated Core request. OAuth `client_credentials` remains available for third-party or policy-controlled integrations; it is not mandatory for self-hosted services.

Do not copy `hmw_pat_*` plaintext into LifeSpace. Create a new service principal/credential, translate HomeMew permissions into LifeSpace scopes and the family binding into Grants on the mapped Space, verify it in staging, update the caller, and revoke the legacy credential after the rollback window. A user-initiated Agent action should continue to preserve the acting user's authority rather than becoming a permanent family administrator.

### Compatibility retirement gate

Remove legacy HomeMew routes/hostname/token verification only when:

- Supported released clients no longer depend on them.
- Observability shows no meaningful legacy traffic for the agreed period.
- External integrations have migrated.
- A rollback to the old writable HomeMew Core is no longer part of the operational plan.

## 18. Phase 9 — HomeMew repository cleanup

Only after the stabilization and compatibility gates pass:

- [ ] Remove migrated Core business implementation from HomeMew.
- [ ] Remove HomeMew-owned D1 migrations that are no longer authoritative, retaining history only where useful for migration/reference.
- [ ] Remove HomeMew Core deploy workflows and Worker resource ownership.
- [ ] Remove duplicated OpenAPI/contract ownership; keep only the pinned/generated LifeSpace contract snapshot required by HomeMew development.
- [ ] Update HomeMew `AGENTS.md` so LifeSpace is explicitly the platform/API source of truth.
- [ ] Archive or delete obsolete HomeMew D1/R2/Queue resources only after backups and retention decisions are complete.

HomeMew remains responsible for its Mini Program, Web/dashboard, app-specific BFF and product UX.

## 19. Recommended implementation PR sequence

Keep PRs capability-sized and independently verifiable. A reasonable initial sequence is:

1. **Platform runtime/CI** — Hono/Wrangler/Vitest/OpenAPI checks, health/status, staging config.
2. **Identity foundation** — global user/app/principal/token model and staging Identity Worker.
3. **Space foundation** — Space, membership, Space Person, Data Grant and authorization tests.
4. **HomeMew identity bridge** — current user/family identity mapping and temporary token compatibility.
5. **Family compatibility** — family -> family Space, membership/invitation compatibility routes.
6. **Events** — schema, attendees, contract, authorization, compatibility and migration transform.
7. **Tasks** — schema, assignees, state transitions, contract and migration transform.
8. **Day records**.
9. **Wishes**.
10. **Remaining parity domains** — anniversaries/avatars/integrations/webhooks/notifications as actually required.
11. **Creation drafts / Queue** if still required at parity freeze.
12. **Cross-Space `/me` aggregation and sharing**.
13. **Generated contracts/client packages** and HomeMew pinned consumption.
14. **Migration tooling + verification harness**.
15. **Full staging rehearsal**.
16. **Production infrastructure + cutover runbook finalization**.
17. **Production data cutover**.
18. **Client modernization and legacy compatibility retirement**.
19. **HomeMew Core cleanup**.

Do not bundle all domains into one migration PR merely because they currently live in one HomeMew Worker.

## 20. Definition of HomeMew migration complete

The migration is complete only when all of the following are true:

- LifeSpace Identity is the authoritative global identity/token service for migrated applications.
- LifeSpace Core is the authoritative owner of migrated business data.
- Current HomeMew production capability is served from LifeSpace without reading/writing HomeMew D1.
- Production data and object storage migration have passed repeatable verification.
- HomeMew Web/Mini Program/display and required integrations operate against LifeSpace.
- Required old Mini Program versions are either upgraded or served only by a tested compatibility façade over the same LifeSpace data.
- Cross-Space authorization follows Space/Data Grant + application-scope rules.
- Old HomeMew Core is no longer a writable production source of truth.
- Legacy compatibility has either been retired or has an explicit, time-bounded removal plan.
- HomeMew repository no longer owns shared platform migrations/contracts/deployments.

At that point new shared domains are added to LifeSpace first and consumed by ALOHA, HomeMew or other vertical applications as clients.
