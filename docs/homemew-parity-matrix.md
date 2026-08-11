# HomeMew -> LifeSpace parity matrix

Updated: 2026-08-11

This document freezes the production-used HomeMew capability baseline and tracks its migration to native LifeSpace capabilities. It is derived from HomeMew `main` at commit `6ecdc7f3`, the canonical HomeMew OpenAPI, Core route registration, migrations, Wrangler bindings, product rules, and released Mini Program API wrappers.

After Phase 2.6, the migration direction changed: **parity means preserving required business/data semantics through the native LifeSpace model, not preserving HomeMew URL paths, response shapes, token formats, or runtime compatibility façades.** HomeMew clients will migrate to the native LifeSpace contract.

## Baseline inventory

### Runtime and durable resources

| Surface | HomeMew baseline | Migration classification | LifeSpace target |
| --- | --- | --- | --- |
| Worker | `homemew-core` | Runtime baseline | Native LifeSpace Core; no production HomeMew API façade target |
| D1 | `homemew-core`, schema version 11 | Durable | Repeatable export/transform into LifeSpace Identity/Core D1 according to service ownership |
| R2 | `homemew-assets` via `AVATARS` | Object storage | Copy/verify objects into the environment-isolated LifeSpace assets bucket; Identity owns `avatars/users/...`, Core owns `avatars/spaces/...`, raw keys stay private |
| Queue | `homemew-creation-drafts` | Ephemeral | Re-create native Space-aware workflow only if still required; do not migrate in-flight messages |
| Cron | hourly creation-draft cleanup | Runtime behavior | Re-create only if native creation drafts remain required |
| Rate limit | AI rate-limit binding | Ephemeral policy state | Re-provision; do not migrate counters |
| Secrets | JWT and AI/provider secrets | Secret | Re-provision through deployment/application secrets; never export as data |

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

## Contract/capability inventory

The HomeMew OpenAPI baseline exposes 60 implemented operations. The table groups those operations by migration capability. The old OpenAPI remains authoritative for understanding source behavior, but it is **not** the target LifeSpace public contract.

| Capability | HomeMew baseline | Native LifeSpace replacement | Status / cutover treatment |
| --- | --- | --- | --- |
| System probes | health and schema/status | Native Core/Identity probes | Foundation complete |
| User profile | read/update profile; user avatar | Identity-owned profile + native user-avatar object behavior | Native Identity 0.2.0 / schema v3 deployed and verified in staging |
| Family listing/profile | list/create/read/update family | `Space(kind=family)` | Native deployed; legacy façade retired by Core 0.8.0 |
| Members | list, change role, remove, leave | Space membership + linked Space Person | Native deployed; legacy façade retired by Core 0.8.0 |
| Invitations | create/list/revoke/preview/join | Core-owned Space invitations | Native deployed; legacy façade retired by Core 0.8.0 |
| Family avatar | upload/read derived URL | Core-owned Space avatar + native object behavior | Native Core 0.9.0 / schema v8 deployed and verified in staging |
| Events | CRUD/search/filter; attendees | Space-owned events + Space Person attendees | Native deployed; legacy façade retired by Core 0.8.0 |
| Tasks | CRUD/search/filter/complete/reopen; assignees | Space-owned tasks + Space Person assignees | Native deployed; legacy façade retired by Core 0.8.0 |
| Day records | CRUD, occurrence history, archive/restore | Space-owned day records + occurrences | Native deployed; legacy façade retired by Core 0.8.0 |
| Wishes | CRUD, lifecycle actions | Space-owned wishes + Space Person owner/claimant/fulfiller | Native deployed; legacy façade retired by Core 0.8.0 |
| External integrations | integration CRUD, credential issue/list/revoke, OAuth client credentials | Identity-owned service principal + `lsp_pat_*` + optional OAuth `client_credentials`; Core Data Grants/scopes | Native Identity 0.3.0 / Core 0.10.0 deployed and verified in staging; HomeMew credentials must be rotated, not copied |
| Creation drafts | asynchronous interpret/job polling and cleanup | Native Space-aware queue workflow if retained | Remaining Phase 2 decision/work |
| Internal user creation | trusted backend user creation | LifeSpace Identity trusted application user creation | Foundation replacement exists |

### Explicitly absent from the released baseline

The frozen HomeMew baseline has no implemented anniversary, notification, outbound webhook, or general attachment API. They are not HomeMew cutover blockers unless a released HomeMew client starts depending on them before the migration freeze is closed.

The Mini Program baseline consumes family/member/invitation/event/task/day-record/wish/integration/avatar/creation-draft capabilities. `currentFamilyId` is presentation state only; in the native client it becomes a selected mapped `spaceId`, not an authorization claim.

## Direction-reset rules

From 2026-08-11 onward:

- Native LifeSpace routes use `/api/v1/spaces/{spaceId}/...` or other canonical platform routes.
- Do not add new `/api/v1/families/...` routes for migration convenience.
- Do not keep old HomeMew response field names or role names as a LifeSpace public API requirement.
- Do not add a production legacy HomeMew token verifier.
- HomeMew UI may retain product terms such as "家庭" while its API/data layer uses `Space`, membership and Space Person.
- Migration mappings and transforms remain mandatory where IDs/models change.
- Phase 2.2-2.6 compatibility code is historical migration work and has been removed from the target Core runtime.

## Core transformation policies

### Family -> Space

| HomeMew concept | LifeSpace concept | Migration/client rule |
| --- | --- | --- |
| `fam_*` family | `spc_*` Space with `kind=family` | Use explicit migration mapping; HomeMew client stores/uses `spaceId` after migration |
| creator/admin | owner or admin membership | Creator becomes owner when valid; other admins become admin |
| member | editor membership | Preserve proven mutation authority unless intentionally changed in final platform policy |
| represented member | linked Space Person | Domain person references use Person IDs, not login user IDs |
| family timezone | Space timezone | Preserve IANA timezone |
| max 8 active members | family Space policy | Platform family-kind invariant as implemented |
| max 3 created families | HomeMew application policy | Must not remain a generic Core platform restriction solely for HomeMew compatibility |
| invitation | Space invitation | Native invitation lifecycle and atomic join/reactivation |

The source family creator is mapped to owner only when still an active administrator; otherwise the deterministic active-admin fallback defined by the migration transform applies. This is migration semantics, not a requirement to expose old HomeMew role responses.

### People references

HomeMew commonly used `userId` for both login identity and represented household subject. Native LifeSpace separates those concepts.

| HomeMew field/use | Native LifeSpace use |
| --- | --- |
| attendee user ID | attendee Space Person ID |
| assignee user ID | assignee Space Person ID |
| day-record `subjectUserId` | `subjectPersonId` |
| wish owner/claimant/fulfiller user | Space Person IDs |
| current authenticated actor | verified principal/user from credential, never request user ID |

HomeMew client adapters must migrate to Person IDs for domain relationships. The platform must not retain a permanent user-ID translation façade to hide this model change.

### Profiles and avatars

- Global user profile data and user-avatar metadata are owned by LifeSpace Identity, not Core.
- Space avatar metadata is owned by Core with the Space record.
- The environment-isolated LifeSpace assets R2 bucket is shared physically but divided by service-owned namespaces: `avatars/users/...` for Identity and `avatars/spaces/...` for Core.
- Raw R2 keys are persistence details and are never public contract fields. Clients receive stable Worker URLs from Identity/Core.
- Avatar replacement preserves the HomeMew safety properties: JPEG/PNG/WebP only, maximum 5 MB, write the new object first, roll it back if metadata persistence fails, and delete the previous object only after success.
- Space avatar replacement uses optimistic Space version concurrency.
- User JWTs issued after Identity 0.2.0 carry both `lifespace-core` and `lifespace-identity` audiences; Core accepts the previous single-Core audience during the issuer rollout window.
- HomeMew migration tooling emits native `avatar_key` metadata plus a deterministic `object-copy-manifest.json` mapping each valid legacy source key to the target LifeSpace namespace.
- Migration validation rejects avatar keys outside the expected legacy user/family owner prefix rather than silently copying cross-owner data.

### Service authentication and external integrations

- Identity owns `svc_*` service principals, opaque `lsp_pat_*` token hashes/metadata and optional OAuth client credentials.
- Core owns Space/Data Grant authorization; a service principal is not made a Space member to obtain access.
- Opaque PATs are introspected through the Core→Identity Service Binding on each request in the initial implementation; Core never reads Identity D1 or stores token hashes.
- OAuth `client_credentials` issues a short-lived service JWT for the same service principal and uses the same current Data Grant/domain authorization in Core.
- Effective service authority remains the intersection of credential/application scope ceilings, current Grant state and domain restrictions.
- Grant revocation affects both opaque and OAuth modes on the next Core request; PAT revocation/disabled principal status affects opaque authentication on the next request.
- HomeMew integration migration emits deterministic service-principal/Data-Grant artifacts plus a credential-rotation report. Existing HomeMew plaintext or secret hashes are never copied.
- Owner-controlled n8n/curl callers may use one direct Core request with `Authorization: Bearer lsp_pat_...`; no OAuth token-acquisition node is required unless OAuth is deliberately selected.

### Tasks

- Preserve stable `tsk_*` IDs where practical.
- Preserve `pending`, `completed`, `cancelled` lifecycle semantics.
- Preserve date-only `dueDate`, optimistic concurrency, soft deletion and audit history.
- Same-Space assignee constraints remain native invariants.
- The old `includeNoDue` OpenAPI/runtime drift is source-system history. Native LifeSpace documents one explicit final behavior; it does not need to preserve the legacy omission behavior after the HomeMew client migrates.

### Day records

- Preserve `elapsed`, `countdown`, `cycle` domain semantics.
- Preserve Space-timezone date-only `today` behavior.
- Preserve occurrence history and anchor/next-due invariants.
- Preserve historical subject meaning after Person deactivation while requiring a valid active Person for new assignments as defined by the native API.
- Preserve optimistic concurrency, archive/restore and soft deletion.

### Wishes

- Preserve stable `wsh_*` IDs where practical.
- Use native Space Person references for owner/claimant/fulfiller.
- Preserve claim/unclaim/fulfill/reopen/archive/restore semantics selected for the native LifeSpace domain.
- Preserve historical people meaning after Person deactivation.
- Preserve date-only `desiredDate`, optimistic concurrency, actor history and soft deletion.
- Service/Agent lifecycle authority is defined by final LifeSpace principal/scope/Data Grant rules, not inferred from HomeMew user-only behavior.

## Migration artifacts vs runtime compatibility

The following **remain required**:

- `legacy_user_id -> LifeSpace user_id` when changed.
- `family_id -> space_id`.
- family member -> membership / Space Person.
- historical actor/person mappings.
- event/task/day-record/wish transforms and semantic validation.
- `object-copy-manifest.json` and object existence/integrity verification for avatars.
- integration/credential ID -> new service-principal/credential metadata mapping.
- migration count, referential-integrity and authorization reports.

The following are **not target architecture**:

- HomeMew `/api/v1/families/...` routes in LifeSpace.
- legacy HomeMew response façades.
- runtime `userId -> personId` translation solely for old clients.
- legacy HomeMew role vocabulary exposed by LifeSpace.
- legacy HomeMew JWT issuer/audience acceptance.
- `hmw_pat_*` credentials reinterpreted as LifeSpace credentials.

## External integration migration

The LifeSpace target capability is now implemented and staging-verified. HomeMew `hmw_pat_*` plaintext must never be copied into LifeSpace.

For each active integration at migration/cutover time:

1. Create/resolve the LifeSpace service principal in the appropriate registered application context.
2. Translate HomeMew permissions into final LifeSpace scopes.
3. Translate the family binding into explicit Data Grants on the mapped Space.
4. Issue a new `lsp_pat_*` Service API Token or approved OAuth credential.
5. Update HomeMew integration UI and the external n8n/script/MCP caller.
6. Verify native LifeSpace allow/deny behavior against staging/production-ready resources.
7. Revoke the old HomeMew credential after cutover and rollback stabilization.

The deterministic migration transform now produces service-principal/Data-Grant output and a credential-rotation report. Reports may map legacy credential identifiers to new non-secret metadata but never export plaintext credentials or legacy hashes.

## HomeMew client migration requirements

Before production cutover, the supported HomeMew client must:

- use `spaceId` rather than a LifeSpace legacy `familyId` route;
- resolve/display membership and Space Person correctly;
- send Person IDs for attendee/assignee/subject/wish-person relationships;
- use a pinned native LifeSpace contract/client version;
- obtain LifeSpace Identity-backed short-lived app-scoped user tokens through the trusted HomeMew WeChat adapter/Cloud Function;
- manage LifeSpace service credentials/Grants for external integrations;
- use Identity-owned user profile/avatar and Core-owned Space avatar behavior through native stable URLs;
- use only native LifeSpace creation-draft behavior if that capability remains in the cutover set.

The UI may continue to present HomeMew concepts such as family/member. This is an application presentation concern, not a platform compatibility requirement.

## Freeze rule

From this baseline forward, any new HomeMew Core capability intended for a released client must include, in the same change:

1. a parity-matrix entry;
2. the final native LifeSpace replacement or an explicit decision that it remains application-local;
3. migration classification and transform/object/secret impact;
4. required HomeMew client change;
5. a decision on whether it blocks cutover.

A HomeMew-only feature may not silently expand the production migration scope, and no new legacy runtime compatibility requirement may be introduced without an explicit new architecture decision.
