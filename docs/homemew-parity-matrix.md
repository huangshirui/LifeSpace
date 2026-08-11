# HomeMew -> LifeSpace parity matrix

Updated: 2026-08-11

This document freezes the Phase 2 migration baseline. It is derived from HomeMew `main` at commit `6ecdc7f3`, the canonical HomeMew OpenAPI, Core route registration, migrations, Wrangler bindings, product rules, and released Mini Program API wrappers.

LifeSpace must update this matrix whenever a released HomeMew client starts depending on a new Core capability during Phase 2.

## Baseline inventory

### Runtime and durable resources

| Surface | HomeMew baseline | Migration classification | LifeSpace target |
| --- | --- | --- | --- |
| Worker | `homemew-core` | Runtime baseline | LifeSpace Core plus temporary legacy compatibility route |
| D1 | `homemew-core`, schema version 11 | Durable | Repeatable export/transform into LifeSpace Core D1 |
| R2 | `homemew-assets` via `AVATARS` | Object storage | Copy verified objects into the isolated LifeSpace assets bucket |
| Queue | `homemew-creation-drafts` | Ephemeral | Do not migrate messages; drain or let expire during cutover |
| Cron | hourly creation-draft cleanup | Runtime behavior | Re-create only if creation drafts remain in the parity freeze |
| Rate limit | AI rate-limit binding | Ephemeral policy state | Re-provision; do not migrate counters |
| Secrets | JWT and AI/provider secrets | Secret | Re-provision through deployment secrets; never export as data |

The HomeMew D1 history is:

1. `0001_create_schema_metadata.sql`
2. `0002_create_user_family_schema.sql`
3. `0003_create_event_task_schema.sql`
4. `0004_user_avatar_key.sql`
5. `0005_consistency_hardening.sql`
6. `0006_family_avatar_key.sql`
7. `0007_external_system_integrations.sql`
8. `0008_unify_time_semantics.sql`
9. `0009_create_day_records.sql`
10. `0010_create_wishes.sql`
11. `0011_create_creation_draft_jobs.sql`

### Contract inventory

The HomeMew OpenAPI currently exposes 60 implemented operations. The table groups them by migration slice; the OpenAPI remains authoritative for request/response details, except where an observed runtime drift is explicitly recorded below.

| Capability | Implemented HomeMew surface | Data class | LifeSpace replacement | Phase 2 status |
| --- | --- | --- | --- | --- |
| System probes | health and schema/status | Runtime | Native Core probes | Foundation complete |
| User profile | read/update profile; user avatar | Durable + object | Identity user profile plus platform object behavior | Not started |
| Family listing/profile | list/create/read/update family | Durable | family-kind Space plus HomeMew compatibility mapping | Deployed and verified in staging |
| Members | list, change role, remove, leave | Durable | Space membership + linked Space Person | Deployed and verified in staging |
| Invitations | create/list/revoke/preview/join | Durable | Core-owned Space invitations | Deployed and verified in staging |
| Family avatar | upload/read derived URL | Object | Space asset behavior | Deferred to R2 slice |
| Events | list/search/filter/create/read/update/delete; attendees | Durable | Space-owned events; attendee Space People | Deployed and verified in staging |
| Tasks | list/search/filter/create/read/update/delete/complete/reopen; assignees | Durable | Space-owned tasks; assignee Space People | Deployed and verified in staging |
| Day records | CRUD, occurrence history, archive/restore | Durable | Space-owned day records and occurrences | Deployed and verified in staging |
| Wishes | CRUD, claim/unclaim/fulfill/reopen/archive/restore | Durable | Space-owned wishes and lifecycle | Not started |
| External integrations | integration CRUD, credential issue/list/revoke, OAuth client credentials | Durable credentials + secret material | Service principal + new opaque `lsp_pat_*` token for owner-controlled n8n/curl/scripts/MCP, optional OAuth `client_credentials` for third parties, and explicit Space Data Grants/scopes; never copy `hmw_pat_*` plaintext | Not started |
| Creation drafts | asynchronous interpret/job polling and cleanup | Ephemeral | Space-aware queue workflow if retained at freeze | Not started |
| Internal user creation | trusted backend user creation | Durable identity | LifeSpace Identity trusted application user creation | Foundation replacement exists |

### Explicitly absent from the released baseline

The current HomeMew OpenAPI has no implemented anniversary, notification, outbound webhook, or general attachment API. These are not Phase 2 parity blockers unless they become implemented and consumed before the freeze. If that happens, add them to this matrix before changing HomeMew production behavior.

The Mini Program currently consumes family, member, invitation, event, task, day-record, wish, integration, avatar, and creation-draft capabilities. `currentFamilyId` remains presentation state and never authorizes access.

## Family Space transformation policy

The first Phase 2 vertical slice maps HomeMew household semantics onto the existing Space foundation.

| HomeMew concept | LifeSpace concept | Rule |
| --- | --- | --- |
| `fam_*` family | `spc_*` Space with `kind=family` | Use an explicit migration map; do not reinterpret IDs |
| creator/admin | owner or admin membership | The creator becomes owner; other HomeMew admins become admin |
| member | editor membership | HomeMew members can mutate household domains, so viewer would be too weak |
| represented member | linked Space Person | Every active migrated member has one active linked person in the same Space |
| family timezone | Space timezone | Store an IANA timezone on the Space; migrated families preserve their value |
| max 8 active members | family Space policy | Enforce transactionally in Core |
| max 3 created families | HomeMew compatibility policy | Do not impose this HomeMew product limit on every LifeSpace application |
| invitation | Space invitation | Store only a token hash; return plaintext once; join atomically validates expiry, uses and member limit |
| active admin invariant | owner/admin invariant | A family Space must retain at least one active owner/admin |
| remove/leave | soft-deleted membership/person link lifecycle | Preserve history and run domain cleanup in the same Core-owned operation |

Generic Space APIs use LifeSpace roles. The temporary HomeMew compatibility facade maps `owner/admin -> admin` and `editor -> member`; `viewer` has no legacy HomeMew equivalent and must not be exposed through the old family-member mutation contract.

The source family creator is mapped to `owner` only when still an active administrator. If the creator is no longer active, the earliest active administrator becomes owner so both the HomeMew last-admin invariant and the LifeSpace manager invariant remain true. Because `owner` is immutable in the native contract, the legacy role endpoint returns a conflict instead of demoting it. This is an intentional platform difference recorded for compatibility testing.

Compatibility tables persist `legacy_user -> LifeSpace user`, `fam -> Space`, member -> membership/Space Person, and invite mappings. They are transitional translation/audit metadata only; all mutable family state remains in native LifeSpace tables. HomeMew user display names are retained as migration snapshots only to support member presentation and invite joins until the user-profile slice owns the final compatibility behavior.

Invitations belong in Core because membership activation, invite redemption, active-member limits, and Space Person creation/reactivation must be one authoritative transaction. External-provider identities and WeChat `openid` mappings remain in the HomeMew application boundary.

Family avatar parity is intentionally not claimed by the first membership/invitation slice. It remains unavailable on LifeSpace compatibility endpoints until the R2 object migration slice is complete.

## Task transformation and compatibility policy

Phase 2.4 keeps one native task record per task and translates only the application-facing identity shape.

| HomeMew concept | LifeSpace concept | Rule |
| --- | --- | --- |
| `tsk_*` task | Space-owned `tasks` row | Preserve the stable task ID while ownership changes from `family_id` to `space_id` |
| `task_assignees.user_id` | `task_assignees.person_id` | Resolve through the exact family membership mapping to the authoritative same-Space `space_person` |
| `assigneeIds` | `assigneePersonIds` | Legacy IDs exist only on the HomeMew compatibility surface; native APIs use Space Person IDs |
| `pending/completed/cancelled` | same lifecycle values | Preserve source status and completion invariants; complete/reopen remain action endpoints |
| `completedBy/createdBy/updatedBy` | principal actor snapshot | HomeMew `system` actors become LifeSpace `service`; user actors map through the frozen user mapping |
| `dueDate` | date-only `YYYY-MM-DD` | Preserve date-only semantics; timestamps and the retired `due` field remain invalid |
| optimistic `version` | optimistic `version` | PATCH, DELETE, complete and reopen reject stale versions |
| delete | soft delete | Preserve history and hide deleted tasks from normal reads/lists |

The D1 schema additionally enforces same-Space task assignees, so a valid foreign-key reference alone cannot attach a Person from another Space.

### Known HomeMew `includeNoDue` contract/runtime drift

The frozen HomeMew OpenAPI declares `includeNoDue` with a default of `true`, but the deployed HomeMew task-list runtime evaluates an omitted query parameter as `false` (`includeNoDue === "true"`). Existing tests cover the explicit `includeNoDue=true` behavior but do not establish the documented default.

LifeSpace Phase 2.4 therefore preserves the observed HomeMew runtime behavior on the compatibility route: omitted means `false`; callers that want undated tasks alongside a due-date range must send `includeNoDue=true`. The native LifeSpace contract also states its behavior explicitly instead of inheriting the contradictory HomeMew documentation. This drift must not be silently changed during migration; a future HomeMew contract correction can be made separately if desired.

## Day-record transformation and compatibility policy

Phase 2.5 preserves HomeMew's date-only household semantics while moving ownership and person references onto the generic Space model.

| HomeMew concept | LifeSpace concept | Rule |
| --- | --- | --- |
| `day_*` day record | Space-owned `day_records` row | Preserve stable record IDs while ownership changes from `family_id` to `space_id` |
| `subjectUserId` | `subjectPersonId` | Native APIs use a same-Space `space_person`; the HomeMew facade translates the legacy user ID through the family membership/person map |
| removed historical subject | deactivated Space Person reference | Existing records keep the Person reference and remain renderable after membership removal; assigning or filtering a new explicit subject still requires an active Person |
| `elapsed/countdown/cycle` | same discriminated kinds | Preserve each kind's field rules and computed state semantics rather than flattening them into a generic JSON rule object |
| family-local `today` | Space-timezone `today` | All date-only computed state and occurrence validation use the owning Space's IANA timezone |
| `anchorDate` | date-only current anchor | Elapsed/cycle anchors cannot be moved by ordinary PATCH; they advance through occurrence creation. Countdown anchor remains directly editable |
| `day_record_occurrences` | Space-owned record occurrence history | Preserve `dyo_*` IDs, `initial/manual` source, notes, actor history and unique date-per-record semantics |
| cycle next due | derived persisted `next_due_date` | Must equal `anchorDate + cycleDays` and is recomputed when a new occurrence advances the anchor or when `cycleDays` changes |
| `active/archived` | same lifecycle | Archived records remain readable but reject edits/new occurrences until restored |
| user/system actors | principal actor snapshots | HomeMew `system` actors become LifeSpace `service`; user actors map through the frozen user mapping |
| optimistic `version` | optimistic `version` | PATCH, DELETE, archive, restore and occurrence creation reject stale versions |
| delete | soft delete | Preserve deletion actor/timestamp and hide deleted records from normal reads/lists |

Non-countdown records preserve their occurrence history during migration. The transform requires exactly one initial occurrence and requires the current `anchorDate` to equal the newest occurrence date. Countdown records must not have occurrence history. These validations prevent a migration from reproducing a row while silently losing the history that gives the current anchor its meaning.

The D1 schema enforces that a referenced subject Person belongs to the same Space. It intentionally does not require that the Person remain active, because the released HomeMew behavior explicitly preserves historical subject presentation after a member is removed. API mutation/filter validation is stricter and requires an active subject when resolving a new person reference.

Phase 2.5 staging acceptance completed on 2026-08-11. The repeatable deployment smoke verified Core schema v6 / contract 0.6.0 and exercised Day-record creation, subject filtering, initial/manual occurrence history, atomic anchor and cycle due-date advancement, optimistic-concurrency rejection, archive read-only behavior, restore/update, authentication denial and soft deletion. Production/HomeMew traffic remained unchanged.

## Compatibility and migration rules

- HomeMew production Core remains the writable baseline until the cutover gate.
- Phase 2 does not dual-write HomeMew and LifeSpace.
- New native routes use `/api/v1/spaces/{spaceId}/...`.
- Temporary `/api/v1/families/...` compatibility routes, when introduced, operate on the same LifeSpace records and never create a second data store.
- Preserve HomeMew resource IDs for domain records where practical. Maintain explicit maps for users, families/Spaces, memberships/Space People, and any ID that changes.
- Preserve date-only, UTC, timezone, cursor, optimistic-concurrency, soft-delete, and audit semantics unless an intentional difference is recorded here.
- External system credentials are durable product data, but deployment secrets are re-provisioned.
- Queue messages, rate-limit counters, expired tokens, and expired creation drafts are not migrated.
- Every migration transform must be repeatable against a fresh staging target and validated by counts, relationships, authorization behavior, and representative API responses.

## Freeze rule

From this baseline forward, any new HomeMew Core capability intended for a released client must include, in the same change:

1. a parity-matrix entry;
2. a LifeSpace replacement/compatibility decision;
3. a migration classification and transform impact;
4. a decision on whether it blocks cutover.

A HomeMew-only feature may not silently expand the production migration scope.
