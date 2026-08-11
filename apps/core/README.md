# LifeSpace Core

Shared Cloudflare Worker business API for Space-owned life data.

## Implemented platform foundation

- Verified RS256 principal authentication and application scopes.
- Space ownership with roles `owner`, `admin`, `editor`, and `viewer`.
- Current Space membership and Data Grant authorization intersection.
- Linked Space People for person-subject domain relationships.
- Health/status diagnostics and standard success/error envelopes.

## Phase 2 native HomeMew capability replacement

Core API contract version **0.8.0** is native-only. It contains the family Space policy and the Space-owned Events, Tasks, Day Records and Wishes needed by the frozen HomeMew migration baseline, but no longer exposes HomeMew `/api/v1/families/...` or `/api/v1/family-invites/...` runtime compatibility facades.

HomeMew remains free to use product terms such as “家庭” and “家庭成员” in its UI. Its application layer maps those product concepts to the native LifeSpace contract:

```text
family            -> Space(kind=family)
family member     -> Space membership + Space Person
familyId          -> spaceId
attendee/assignee -> Space Person ID
day subject       -> Space Person ID
wish people       -> Space Person ID
```

The retired compatibility implementation from Phase 2.2–2.6 is migration history, not target architecture. Migration mapping tables and transform scripts remain because they are needed to deterministically transform HomeMew production data and preserve audit traceability; native request handling does not consult those mappings.

## Native domain behavior

- Every Space stores an IANA `timezone`; creation defaults to `UTC` when omitted.
- Space profile updates use optimistic-concurrency `version`.
- Family Spaces allow at most eight active memberships and retain at least one active owner/admin.
- Membership activation/deactivation keeps its linked Space Person consistent.
- Core owns hashed, expiring, revocable Space invitations. Plaintext invitation tokens are returned exactly once at creation; redemption atomically creates/reactivates membership plus Space Person.
- Events are stored against `space_id`. Attendees are active same-Space `space_person` references. Timed instants are canonical UTC with display timezones; all-day ranges use half-open dates; update/delete use optimistic versions and soft deletion.
- Tasks are stored against `space_id`. Assignees are active same-Space `space_person` references. Status is `pending`, `completed`, or `cancelled`; `dueDate` is date-only; PATCH/DELETE/complete/reopen use optimistic versions. When a due-date range is supplied, omitted `includeNoDue` is explicitly `false`.
- Day Records are Space-owned date-only records with `elapsed`, `countdown`, and `cycle` kinds. Computed state uses the owning Space timezone. Elapsed/cycle records preserve occurrence history; manual occurrences advance the anchor atomically. Archived records are readable but immutable until restored. Native subjects use Space Person IDs and historical subject references remain renderable after deactivation.
- Wishes are Space-owned records with `open`, `claimed`, `fulfilled`, and `archived` lifecycle states. Owner, claimant, and fulfiller are durable same-Space Person references. Phase 2.6 lifecycle actions still require a current user principal with an active linked Space Person; service/Agent lifecycle semantics belong to the external-integrations slice.

## HomeMew migration transforms

The following scripts deliberately remain even though runtime compatibility has been retired. They convert the frozen HomeMew schema-v11 snapshot into native LifeSpace records and mapping/audit artifacts.

### Family / membership / invite transform

```sh
node scripts/homemew-family-transform.mjs \
  --input homemew-family-snapshot.json \
  --out-dir migration-output
```

The normalized snapshot includes `users`, `families`, `familyMembers`, `familyInvites`, and `inviteRedemptions`, plus `source.schemaVersion: "11"` and an RFC 3339 UTC `exportedAt`. The transform writes deterministic `identity.sql`, `core.sql`, `mapping-manifest.json`, and `migration-report.json`.

### Events

```sh
node scripts/homemew-event-transform.mjs \
  --input homemew-event-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `evt_*`, versions, audit timestamps, soft deletion and time semantics; attendee user relations become exact Space Person relations.

### Tasks

```sh
node scripts/homemew-task-transform.mjs \
  --input homemew-task-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `tsk_*`, lifecycle, date-only due dates, completion/audit actors and soft deletion; assignee user relations become exact Space Person relations.

### Day Records

```sh
node scripts/homemew-day-record-transform.mjs \
  --input homemew-day-record-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `day_*` / `dyo_*`, kind rules, anchors, cycle due dates, attention settings, status, versions, soft deletion and occurrence history. Historical `subjectUserId` values become mapped Space Person references.

### Wishes

```sh
node scripts/homemew-wish-transform.mjs \
  --input homemew-wish-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `wsh_*`, lifecycle, desired dates, actors, versions and historical owner/claimant/fulfiller relations as Space Person references.

Canonical request and response syntax lives in `openapi.yaml`. D1 migrations live in `migrations/`. Migration maps under the compatibility-era schema remain migration/audit artifacts, not public runtime models.

## Verification

`pnpm --filter @lifespace/core check` runs Wrangler binding drift checks, canonical OpenAPI checks, Workers-runtime D1 integration tests, Node migration-transform tests, TypeScript checking, and Wrangler dry-run build. Native-domain integration tests use only `/api/v1/spaces/...` and explicitly verify that retired HomeMew compatibility paths return `404`.
