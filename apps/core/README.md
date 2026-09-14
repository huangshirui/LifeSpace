# LifeSpace Core

Shared Cloudflare Worker business API for Space-owned life data.

## Implemented platform foundation

- Verified RS256 principal authentication and application scopes.
- Space ownership with roles `owner`, `admin`, `editor`, and `viewer`.
- Current Space membership and Data Grant authorization intersection.
- Linked Space People for person-subject domain relationships.
- Health/status diagnostics and standard success/error envelopes.

## Model Control Plane

Model Registry validation/publication/retirement, immutable Model Contract governance and optional AI Model Proposal APIs are declared separately in `model-control-plane.openapi.yaml` **0.2.0**. Ordinary Runtime consumers do not need to pin this contract. Service automation keeps `models:manage`; Console model mutations add the Platform Admin human-actor/audit overlay.

## Integration / Eventing

Webhook Endpoint / Event Subscription management, delivery diagnostics/test-send and signed reference-only outbound Webhook representation are declared in `integration-eventing.openapi.yaml` **0.1.0**. The routes still execute in the same Core Worker, but Runtime-only consumers do not need to pin Eventing.

## Current Kernel Runtime Discovery

The current business-facing Core Kernel contract is **0.36.0**. Progressive single-model semantic detail now exposes one `query.canonical` descriptor for the structured Canonical Query transport. The immutable Model Contract and Runtime Discovery derive its search fields, typed filter targets/operators, ordered sort, limits and cursor bindings from the same implementation source. Older Generic/Capability GET metadata remains only as explicitly deprecated compatibility metadata while adapters migrate. Generic consumers may choose the projection size appropriate to the task:

- `GET /api/v1/spaces/{spaceId}/_discovery` — full current capability metadata for one known Space;
- `GET /api/v1/me/_discovery` — full aggregate current capability metadata across reachable Spaces;
- `GET /api/v1/me/_discovery/inventory` — compact current capability inventory with de-duplicated coarse model facts and minimal per-Space visibility/access edges;
- `GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}` — progressive static semantic detail for one currently visible model;
- `GET /api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}` — bounded current relation target selection using canonical Person `displayName` or ordinary-record `referenceLabel` semantics under current source/target Model authority;
- `POST /api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}` — bounded source-field-aware hydration of existing Person or ordinary-record relation IDs into minimal current labels with opaque per-item unavailable results.

The progressive Runtime Discovery representations are Candidate/Public Context Projections. They reflect current visibility when requested but never authorize execution; every CRUD/query/Action rechecks current authority and model/Capability rules.

Ordinary Generic GET list parameters are compatibility syntax and now lower deterministically into the Canonical Query executor. Previously issued Generic GET v1/v2 cursors remain accepted during transition. Calendar and Temporal special GET ordering still use their compatibility planners until those computed orderings are represented by Canonical Sort.

## Historical Phase 2 HomeMew capability replacement

The Phase-2 Core API contract **0.8.0** was a native-only proving baseline. It contained the family Space policy and the Space-owned Events, Tasks, Day Records and Wishes needed by the then-frozen HomeMew migration baseline, and no longer exposed HomeMew `/api/v1/families/...` or `/api/v1/family-invites/...` runtime compatibility facades.

That Phase-2 contract is historical evidence, not the current ordinary-model contract. HomeMew remains free to use product terms such as “家庭” and “家庭成员” in its UI. Its application layer maps those product concepts to native LifeSpace concepts:

```text
family            -> Space(kind=family)
family member     -> Space membership + Space Person
familyId          -> spaceId
attendee/assignee -> Space Person ID
day subject       -> Space Person ID
wish people       -> Space Person ID
```

The retired compatibility implementation from Phase 2.2–2.6 is migration history, not target architecture. Migration mapping tables and transform scripts remain because they are needed to deterministically transform HomeMew migration snapshots and preserve audit traceability; native request handling does not consult those mappings.

## Current runtime and model authority

Current Kernel-level behavior that is intentionally explicit outside ordinary Model Definitions includes:

- Every Space stores an IANA `timezone`; creation defaults to `UTC` when omitted.
- Space profile updates use optimistic-concurrency `version`.
- Family Spaces allow at most eight active memberships and retain at least one active owner/admin.
- Membership activation/deactivation keeps its linked Space Person consistent.
- Core owns hashed, expiring, revocable Space invitations. Plaintext invitation tokens are returned exactly once at creation; redemption atomically creates/reactivates membership plus Space Person.

Ordinary business-model semantics such as the current Event, Task, Day Record and Wish fields, lifecycle states, Actions, query metadata and Capability bindings are **not duplicated in this README**. Their current sources of truth are:

- shipped baseline Model Definitions: `model-catalog/baseline-models.json`;
- normative Model Definition / Policy / Action / Capability DSL semantics: `../../docs/model-definition-spec.md`;
- the currently published Model Registry plus immutable generated `mct_*` Model Contract Revision;
- current Runtime/Capability tests, including baseline-model convergence and Generic Runtime/Workflow/Temporal coverage.

Canonical ordinary Runtime addressing is `/api/v1/spaces/{spaceId}/models/{modelKey}/records/...`. Historical Phase-2 lifecycle prose and migration transforms below are preserved as evidence only and must not be treated as the current Model Contract.

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

`pnpm --filter @lifespace/core check` runs Wrangler binding drift checks, canonical OpenAPI checks, Workers-runtime D1 integration tests, Node migration-transform tests, TypeScript checking, and Wrangler dry-run build. Current ordinary-model behavior is verified through the Model Catalog/Generic Runtime/Capability tests rather than by duplicating domain lifecycle prose in this README.
