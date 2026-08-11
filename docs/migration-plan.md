# HomeMew Core -> LifeSpace Migration Plan

## 1. Goal

Migrate HomeMew's proven shared backend capabilities into LifeSpace while replacing HomeMew-specific ownership, identity and authorization assumptions with the final LifeSpace platform model.

The migration target is **not** "finish every future LifeSpace domain before switching HomeMew" and, as of the direction reset approved after Phase 2.6 on 2026-08-11, it is also **not** "make LifeSpace emulate the released HomeMew Core API".

The target is:

> Build the LifeSpace platform foundation, implement every production-used HomeMew capability through the final native LifeSpace contract, migrate HomeMew clients to that contract, rehearse and verify data migration, cut production over safely, then retire HomeMew's business Core.

LifeSpace becomes the sole source of truth for Identity integration, Space/Data Grant authorization, shared business domains, migrations, contracts and platform infrastructure. HomeMew remains an application on top of LifeSpace and adapts its Mini Program, Cloud Functions/BFF and integrations to the platform rather than requiring the platform to preserve the old HomeMew API.

## 2. Non-negotiable principles

- Migrate by capability, not by copying `apps/core` wholesale.
- Implement new or remaining migration work against the final native LifeSpace model and contract; do not add new HomeMew runtime compatibility routes, response façades or legacy-token verification paths.
- Compatibility code already implemented in Phase 2.2-2.6 is migration history, not target architecture. Remove it before production cutover after preserving the migration transforms and audit mappings that remain necessary.
- Keep the current HomeMew Core operational until LifeSpace is deployed, the native HomeMew client is verified, and every required production capability is ready.
- Do not make HomeMew depend on an undeployed or `planned` LifeSpace endpoint.
- Do not dual-write HomeMew D1 and LifeSpace D1 during normal migration. For this project size, a short controlled write-freeze cutover is safer than distributed dual-write consistency.
- Every durable business record has one source of truth before and after the cutover.
- Preserve business meaning, audit history and stable resource IDs where practical. Where a platform ID must change, use an explicit migration mapping rather than pretending two identity domains are the same.
- Migration mappings are data-migration/audit artifacts, not a runtime API compatibility layer.
- Separate global Identity concerns from Core Space/domain authorization. Identity and Core have separate service/data ownership.
- Production and staging resources remain physically isolated.
- Migration tooling must be repeatable and idempotent enough to run multiple staging rehearsals from a fresh target database.
- A migration is not accepted based only on row counts. Contract, authorization, relationships, domain semantics and representative native API results must also be verified.
- HomeMew product terminology may remain `family`, `member`, etc. in the UI, but application code translates those concepts to native LifeSpace `Space`, `membership` and `Space Person` contracts.
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
  -> LifeSpace Core native API

HomeMew Mini Program
  -> HomeMew login Cloud Function resolves WeChat openid -> LifeSpace user_id
  -> LifeSpace Identity issues a short-lived HomeMew-app-scoped bearer token
  -> Mini Program calls LifeSpace Core native API directly

Owner-controlled HomeMew integrations
  -> LifeSpace Service API Token / approved service credential
  -> LifeSpace Core native API
```

There is no production target in which `homemew.aisr.online` or `/api/v1/families/...` remains a permanent façade over LifeSpace. The old HomeMew Core remains available as the production baseline until cutover, then as a temporary read-only rollback reference during stabilization.

## 4. Migration scope and parity inventory

Maintain a parity inventory of every HomeMew capability currently used by a released client or external integration.

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

The inventory describes **business and semantic parity requirements**, not a requirement to reproduce HomeMew URL paths or response shapes. For each capability, determine the final LifeSpace replacement, data transform, downstream HomeMew client change and whether it blocks cutover.

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

Family settings that are truly Space-level settings may migrate to the Space. HomeMew-only presentation or product-limit settings remain in the HomeMew application boundary.

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

Events, tasks, health/growth records and future person-subject domains reference Space People where the relationship represents a person inside the Space, rather than assuming every represented person is an authenticated user.

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
- Credential metadata when needed for migration audit/reconciliation.
- Webhook subscriptions and durable delivery configuration when implemented before the freeze.
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

Legacy `hmw_pat_*` plaintext is not migrated. Active integrations receive new LifeSpace credentials according to `docs/service-authentication.md`.

## 7. Phase 0 — Baseline and migration controls

**Status: complete — the HomeMew production baseline is frozen in `docs/homemew-parity-matrix.md` on 2026-08-10.**

### Work

- [x] Establish LifeSpace repository and nested `AGENTS.md` hierarchy.
- [x] Record platform architecture, permission and contract principles.
- [x] Inventory all current HomeMew Core routes, OpenAPI operations, D1 migrations, R2 usage, Queues, crons, external integrations and Mini Program/Web callers.
- [x] Build the parity matrix for the production-used HomeMew capability baseline.
- [x] Identify all external systems and credentials that must survive cutover.
- [x] Record current production resource names and current schema version.
- [x] Define migration freeze rules: any new HomeMew Core capability intended for a released client must also be reflected in this migration plan and parity matrix.

### Exit gate

- No unknown production-facing Core capability remains outside the parity inventory.
- Ownership of every current HomeMew data set is classified as durable, object, ephemeral, derived or secret.

## 8. Phase 1 — LifeSpace platform foundation

Build the platform pieces that every migrated domain depends on before porting event/task business routes.

**Status: complete — staging foundation deployed and end-to-end verified on 2026-08-10.**

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

- [x] Global users.
- [x] Application-owned external identity mapping boundary and trusted backend exchange contract; provider IDs stay outside LifeSpace Core/Identity storage.
- [x] Registered applications/clients.
- [x] User/app/service/device principal vocabulary.
- [x] Short-lived Core access token issuance and verification contract.
- [x] Token `sub`, `iss`, `aud`, `client_id/azp`, scope, expiry and revocation rules.
- [x] Identity and Core signing/verification mechanism appropriate for separate services.
- [x] Web SSO/session model documented without shared parent-domain cookies; runtime browser SSO remains demand-driven.
- [x] Trusted backend token exchange primitive for Mini Program/application adapters; provider login and mapping remain application-owned.

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

```text
auth-staging.aisr.online
core-staging.aisr.online
LifeSpace Identity staging D1
LifeSpace Core staging D1
staging R2 bucket(s)
staging Queue(s)
staging secrets
```

The Phase 1 gate was verified by the staging deployment smoke test: Identity and Core deployed independently, runtime/schema status endpoints succeeded, a trusted staging application created a user, Identity issued an RS256 app-scoped token, Core accepted it to create/read a Space, unauthenticated access was denied, and `pnpm check` passed.

## 9. Phase 2 — Native HomeMew capability migration

**Status: in progress. Phase 2.1-2.6 are deployed and verified in staging. Direction reset approved after Phase 2.6 on 2026-08-11.**

Phase 2 now has one purpose: ensure every production-used HomeMew backend capability has a complete **native LifeSpace** replacement and deterministic migration path.

A slice is complete only when its native contract, schema, authorization, implementation, tests, migration transform and staging verification are complete. HomeMew legacy URL/response compatibility is no longer a completion requirement.

### 9.1 Completed history through Phase 2.6

The following work is complete and remains valid:

1. Family Space policy, memberships, invitations and Space People.
2. Events and attendees as Space-owned records.
3. Tasks and assignees as Space-owned records.
4. Day records and occurrence history as Space-owned records.
5. Wishes and lifecycle using Space Person references.
6. Deterministic transforms/mappings for these durable domains.
7. Native OpenAPI, D1 schemas, authorization and repeatable staging E2E for the completed slices.

Phase 2.2-2.6 also implemented temporary HomeMew compatibility routes and compatibility tests. Those implementations are preserved as historical completed work but are **not part of the target architecture** after the 2026-08-11 direction reset.

### 9.2 Native-only direction reset

From this point forward:

- Do not add another `/api/v1/families/...` route solely for HomeMew migration.
- Do not preserve HomeMew response field names solely to avoid changing the HomeMew client.
- Do not add legacy HomeMew token verification to LifeSpace production.
- Do not encode HomeMew-only product limits into generic Core APIs. For example, HomeMew's three-created-family product limit belongs in the HomeMew application policy, not generic Space creation.
- Keep `fam_* -> spc_*`, user, membership/Person and domain ID mappings required by deterministic migration and audit.
- Keep migration transforms and semantic validation already implemented.
- Remove compatibility-only runtime routes, compatibility-only OpenAPI surfaces, allowlists, role/field translation and tests before the native HomeMew client is accepted for production cutover.

### 9.3 Remaining Phase 2 slices

Recommended order:

1. **Native-only convergence / compatibility retirement** — remove the Phase 2.2-2.6 runtime compatibility façade while preserving transforms/mappings and native tests.
2. **User profile + R2 avatars/objects** — implement final Identity/Core ownership and object semantics required by HomeMew.
3. **External integrations** — service principals, opaque `lsp_pat_*` Service API Tokens, optional OAuth `client_credentials`, scopes, Data Grants and migration/report tooling. Do not reproduce `hmw_pat_*` as a LifeSpace credential format.
4. **Creation drafts / Queue** — implement a Space-aware native workflow only if still required by the parity freeze.
5. **Final native parity sweep** — verify every production-used HomeMew capability has a native deployed replacement and deterministic migration path.

### Per-domain checklist from the reset onward

For every remaining migrated domain:

- [ ] Define ownership (`space_id`) and subject (`space_person_id` where applicable).
- [ ] Define supported principals and required app scopes.
- [ ] Define Space role/Data Grant authorization.
- [ ] Port schema and indexes with important invariants enforced in D1.
- [ ] Preserve or explicitly transform version/deletion/audit behavior.
- [ ] Preserve required UTC/date-only/timezone semantics.
- [ ] Define the final native search/filter/sort/cursor semantics.
- [ ] Update canonical OpenAPI.
- [ ] Update contract checks.
- [ ] Add CRUD/state-transition tests.
- [ ] Add cross-Space isolation tests.
- [ ] Add user/service/device allow/deny tests as applicable.
- [ ] Add stale-version and deletion/history tests where applicable.
- [ ] Add a migration transform and validation for durable data.
- [ ] Record HomeMew client changes required to consume the native contract.
- [ ] Record intentional semantic differences from the legacy HomeMew implementation.

### Phase 2 exit gate

Phase 2 is complete only when:

- Every production-used HomeMew backend capability has a tested, deployed native LifeSpace replacement.
- Every durable HomeMew data set has a deterministic transform or an explicit retirement decision.
- Required R2 object migration behavior is implemented and testable.
- Required service/integration authentication is implemented according to the final LifeSpace service-authentication model.
- Staging contains no HomeMew compatibility API that is required by the target migration path.
- The canonical LifeSpace contracts expose only implemented/deployed functionality that the new HomeMew client may consume.

## 10. Phase 3 — HomeMew native client migration

HomeMew becomes an ordinary LifeSpace application before production data cutover.

### 10.1 Mini Program API migration

Update the HomeMew Mini Program API/data-access layer to consume the pinned native LifeSpace contract.

Product vocabulary does not need to change. The UI can continue to say "家庭" and "家庭成员" while application code uses:

```text
HomeMew family        -> LifeSpace Space(kind=family)
HomeMew familyId      -> LifeSpace spaceId
HomeMew member        -> membership + Space Person
attendee/assignee     -> Space Person ID
Day-record subject    -> Space Person ID
Wish owner/claimant   -> Space Person ID
```

The Mini Program must not retain a hidden dependency on `/api/v1/families/...`.

### 10.2 WeChat identity adapter / Cloud Function

Keep WeChat-specific identity handling in HomeMew:

```text
Mini Program login
  -> HomeMew Cloud Function obtains trusted openid
  -> HomeMew mapping resolves openid -> LifeSpace user_id
  -> trusted HomeMew backend authenticates to LifeSpace Identity
  -> Identity issues short-lived HomeMew-app-scoped Core token
  -> Mini Program calls LifeSpace Core native API
```

The Mini Program must never submit an arbitrary LifeSpace `user_id` for token issuance. HomeMew keeps provider mapping and WeChat secrets; LifeSpace Identity owns the resulting global user and token issuance.

### 10.3 Contract consumption

- [ ] HomeMew pins an explicit compatible LifeSpace contract/client version.
- [ ] Repository-local generated/read-only contract snapshots are reproducible and not hand-edited.
- [ ] HomeMew client types and API wrappers use native Space/Person fields.
- [ ] App-specific presentation aliases remain local to HomeMew and do not leak back into Core.

### 10.4 External integrations and app-specific policy

- Update HomeMew integration management UI/flows to create and manage LifeSpace service credentials and Grants instead of HomeMew-specific credentials.
- Move HomeMew-only product rules that are not platform invariants into the HomeMew application boundary.
- Keep Core as the security authority for Space membership, Data Grants, app scopes and domain authorization.

### Phase 3 exit gate

- The released-candidate HomeMew Mini Program and required Cloud Functions operate against LifeSpace staging using only native LifeSpace APIs.
- Family/member/event/task/day-record/wish/profile/avatar/integration/creation-draft flows required at cutover pass application E2E.
- The login flow produces LifeSpace Identity-backed app-scoped tokens.
- No supported HomeMew application request depends on a LifeSpace `/api/v1/families/...` compatibility route or legacy HomeMew token verifier.
- Any old HomeMew client version that will not work after cutover is explicitly outside the supported cutover set; HomeMew uses its normal client update/upgrade UX rather than adding a permanent Core compatibility layer.

## 11. Phase 4 — Migration tooling and full staging rehearsal

Do not perform the first full transformation against the final production target.

### 11.1 Migration tooling

Version-controlled tooling under LifeSpace must be able to:

1. Read a HomeMew D1 export/snapshot.
2. Create migration maps for users/families/members and any changed identifiers.
3. Transform records into the current native LifeSpace schema.
4. Import into an empty LifeSpace target database.
5. Copy/verify required R2 objects when moving buckets.
6. Produce a machine-readable migration report.
7. Run integrity, authorization and semantic verification.

The migration must be reproducible from a clean staging database. Do not rely on manual D1 edits for normal migration steps.

### 11.2 Required mapping artifacts

At minimum, persist migration-run mappings for:

```text
legacy_user_id   -> lifespace_user_id       when changed
family_id        -> space_id
family_member    -> space_membership
represented user -> space_person
legacy integration/credential IDs -> new principal/credential metadata
```

These mappings are migration artifacts and audit aids. They must not become a public runtime compatibility model.

### 11.3 Full rehearsal

Use a recent HomeMew production snapshot or a production-like sanitized copy:

```text
HomeMew snapshot
  -> migration tool
  -> fresh LifeSpace staging D1/R2
  -> integrity checks
  -> native API semantic checks
  -> native HomeMew Mini Program / Cloud Function E2E
```

Repeat until the migration is deterministic and the verification report is clean.

### 11.4 Verification requirements

Verify at least:

- Users and user mapping.
- Families -> family Spaces.
- Memberships and Space People.
- Events/attendees.
- Tasks/assignees.
- Day records/occurrences.
- Wishes and lifecycle relations.
- Profiles and object storage.
- Integrations/service principals/Grants.
- Creation-draft durable state only if explicitly retained.
- Referential integrity and same-Space person relationships.
- Timed event UTC ordering and all-day ranges.
- Task date-only semantics.
- Search/filter/pagination behavior required by the new HomeMew client.
- Optimistic concurrency and soft-deletion behavior.
- Day-record computed state and occurrence history.
- Wish claim/fulfill/archive rules.
- Membership removal lifecycle behavior.
- App scope and service/Data Grant enforcement.

Where useful, compare legacy HomeMew source behavior with native LifeSpace behavior, but normalize intentional model/contract differences. The purpose is semantic migration validation, not URL/response-shape compatibility.

### Phase 4 exit gate

- At least one complete migration from a fresh HomeMew snapshot into a fresh LifeSpace staging target succeeds.
- The migration report explains all expected count/ID transformations.
- Authorization and semantic checks pass.
- The native HomeMew client passes its required E2E against the migrated staging data.
- No compatibility façade is needed to complete the rehearsal.

## 12. Phase 5 — Production cutover preparation

Production cutover is permitted only after Phases 2, 3 and 4 pass. Post-cutover platform evolution is not a prerequisite.

### Required preconditions

- [ ] LifeSpace production Identity/Core Workers are deployed using production-only resources.
- [ ] Production D1/R2/Queue bindings are verified by `/api/v1/status` and smoke checks.
- [ ] Current HomeMew parity matrix is 100% complete for production-used capability under the native-only definition.
- [ ] At least one full staging migration rehearsal succeeded from a fresh target.
- [ ] Migration and verification scripts are committed and versioned.
- [ ] HomeMew native Mini Program and Cloud Functions are release-ready and tested against LifeSpace staging.
- [ ] HomeMew WeChat identity mapping/token exchange is tested against LifeSpace production preparation resources without exposing arbitrary-user token issuance.
- [ ] External integrations have new LifeSpace credentials/Grants and an explicit switch procedure.
- [ ] Unsupported legacy HomeMew client versions and the user update path are explicitly understood; no LifeSpace compatibility layer will be added solely to keep them running.
- [ ] Rollback decision points are written down before the maintenance window starts.

### Token/client transition

Preferred transition:

1. Release/update the HomeMew Cloud Function so the supported client obtains LifeSpace Identity-backed user tokens.
2. Release the native LifeSpace HomeMew Mini Program build and verify it against staging/production-ready endpoints.
3. Ensure the controlled HomeMew user population is running the supported build before final cutover, or use HomeMew's normal upgrade UX to prevent unsupported legacy clients from continuing.
4. Do not add legacy HomeMew issuer/audience acceptance to LifeSpace solely to avoid upgrading the HomeMew client.

## 13. Phase 6 — Production data cutover

Use a controlled write-freeze instead of normal dual-write.

### Cutover sequence

1. Enter the maintenance window for write operations.
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
13. Run representative native LifeSpace API semantic/smoke tests.
14. Activate/verify new external integration credentials and Grants without duplicate delivery.
15. Point the supported HomeMew client/Cloud Function configuration to LifeSpace production native endpoints where configuration switching is required.
16. Verify HomeMew Mini Program, Web/dashboard, household display and critical integrations against native LifeSpace while writes are still frozen.
17. Make the go/no-go decision.
18. If GO, enable LifeSpace writes and resume approved schedulers/Queue producers.
19. Keep old HomeMew Core and its D1 read-only for the defined stabilization period.
20. Monitor errors, authorization denials, Queue failures, integration failures and application behavior.

Do not deploy a production legacy HomeMew API façade as part of cutover. Do not delete the old database or Core deployment during the cutover window.

## 14. Rollback strategy

### Before LifeSpace writes are enabled

Rollback is simple and should be preferred if any critical validation fails:

```text
LifeSpace validation fails
  -> keep LifeSpace writes disabled
  -> restore HomeMew routing/configuration
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

## 15. Phase 7 — Stabilization and HomeMew Core cleanup

During stabilization:

- Monitor native HomeMew client behavior, Identity exchanges, authorization denials, object access, Queue behavior and service integrations.
- Keep the old HomeMew Core/D1 read-only for the agreed rollback evidence window.
- Do not introduce a compatibility façade as a shortcut for fixing native client/platform defects; fix the owning native contract or client.

After the rollback window is closed:

- [ ] Remove migrated Core business implementation from HomeMew.
- [ ] Remove HomeMew-owned D1 migrations that are no longer authoritative, retaining history only where useful for migration/reference.
- [ ] Remove HomeMew Core deploy workflows and Worker resource ownership.
- [ ] Remove duplicated OpenAPI/contract ownership; keep only the pinned/generated LifeSpace contract snapshot required by HomeMew development.
- [ ] Update HomeMew `AGENTS.md` so LifeSpace is explicitly the platform/API source of truth.
- [ ] Revoke legacy HomeMew integration credentials after new LifeSpace credentials are verified and rollback no longer requires them.
- [ ] Archive or delete obsolete HomeMew D1/R2/Queue resources only after backups and retention decisions are complete.

HomeMew remains responsible for its Mini Program, Web/dashboard, app-specific BFF/Cloud Functions, provider identity mapping and product UX.

## 16. Phase 8 — Post-cutover LifeSpace platform evolution

These are valid LifeSpace platform capabilities but are **not HomeMew cutover blockers unless a concrete supported HomeMew flow requires one of them before cutover**.

Examples:

- `/api/v1/me/events` across all currently accessible Spaces.
- `/api/v1/me/tasks` and other aggregate views when approved.
- Source-Space metadata and effective permission in aggregate responses.
- Cross-Space Data Grant reads without copying source records.
- Read-only sharing from personal Space to family Space.
- Event `free_busy` sharing semantics.
- Broader ALOHA cross-Space aggregation and sharing experiences.

Tests must continue proving that shared records retain exactly one source Space, read-only grantees cannot mutate the source, and revoked Grants stop access from current Core authorization state.

## 17. Recommended implementation sequence from the 2026-08-11 reset

1. **Phase 2 native-only convergence** — remove completed compatibility runtime surfaces while preserving migration maps/transforms.
2. **User profile + R2 objects**.
3. **Service principals / Service API Tokens / integration Grants and migration tooling**.
4. **Creation drafts / Queue** if still required by the parity freeze.
5. **Final native parity sweep**.
6. **HomeMew Mini Program API-client migration** to Space/Space Person/native domain contracts.
7. **HomeMew WeChat Cloud Function identity migration** to LifeSpace Identity exchange.
8. **HomeMew integration-management migration** to LifeSpace service credentials/Grants.
9. **Full native HomeMew staging E2E**.
10. **Migration tooling finalization + full staging data rehearsal**.
11. **Production infrastructure + cutover runbook finalization**.
12. **Production data cutover**.
13. **Stabilization and HomeMew Core cleanup**.
14. **Cross-Space aggregation/sharing and other non-blocking platform evolution**.

Do not bundle all domains into one migration PR merely because they currently live in one HomeMew Worker.

## 18. Definition of HomeMew migration complete

The migration is complete only when all of the following are true:

- LifeSpace Identity is the authoritative global identity/token service for migrated HomeMew flows.
- LifeSpace Core is the authoritative owner of migrated business data.
- Current supported HomeMew production capability is served through native LifeSpace APIs without reading/writing HomeMew D1.
- Production data and object storage migration have passed repeatable verification.
- HomeMew Mini Program/Web/display and required integrations operate against native LifeSpace contracts.
- HomeMew WeChat/provider identity mappings remain in the HomeMew application boundary while tokens come from LifeSpace Identity.
- Cross-Space authorization, where used, follows Space/Data Grant + application-scope rules.
- Old HomeMew Core is no longer a writable production source of truth.
- No HomeMew legacy runtime compatibility façade or legacy token verifier is required in LifeSpace production.
- HomeMew repository no longer owns shared platform migrations/contracts/deployments.

At that point new shared domains are added to LifeSpace first and consumed by ALOHA, HomeMew or other vertical applications as clients.