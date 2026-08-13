# HomeMew -> LifeSpace parity matrix

Updated: 2026-08-13

**Phase 2 parity status: complete. Phase 4 integration-readiness review: complete.** This document freezes the production-used HomeMew capability baseline and records its final native LifeSpace replacement. The baseline is derived from HomeMew `main` at commit `6ecdc7f3`, its canonical OpenAPI, Core route registration, migrations, Wrangler bindings, product rules and released Mini Program API wrappers.

Parity means preserving required business/data semantics through the native LifeSpace model. It does **not** mean preserving HomeMew URL paths, response shapes, token formats or runtime compatibility façades.

The Phase-2 Core `0.11.0` / Identity `0.3.0` pins below are historical parity evidence only. The accepted HomeMew application contract after Phase 4 is:

```text
Identity Contract:    0.4.0
Core Kernel Contract: 0.12.0
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Integration Profile:  infra/homemew-integration-profile.json / profileVersion 1 / accepted
```

## Baseline runtime/resources

| Surface | HomeMew baseline | Migration classification | Final LifeSpace treatment |
| --- | --- | --- | --- |
| Worker | `homemew-core` | Runtime baseline | Native LifeSpace Core; no permanent HomeMew API façade |
| D1 | `homemew-core`, schema v11 | Durable | Repeatable export/transform into service-owned LifeSpace Identity/Core D1 |
| R2 | `homemew-assets` / `AVATARS` | Object | Copy/verify into environment-isolated LifeSpace assets; Identity owns `avatars/users/...`, Core owns `avatars/spaces/...` |
| Queue | `homemew-creation-drafts` | Ephemeral | Native Registry-driven Creation Draft Queue; do not migrate in-flight messages |
| Cron | hourly Creation Draft cleanup | Runtime | Native hourly 24-hour-TTL cleanup deployed |
| AI rate limit | HomeMew AI rate-limit binding | Ephemeral | Native per-user AI rate limit re-provisioned; counters are not migrated |
| Secrets | JWT + AI/provider + platform secrets | Secret | Re-provision only; never ordinary data-migrate secrets |

HomeMew schema-v11 migration history remains the source inventory for users/families/events/tasks/avatars/integrations/time semantics/day records/wishes/Creation Draft jobs. Creation Draft rows are classified as ephemeral and are not part of durable data migration.

## Production capability inventory

The frozen HomeMew OpenAPI exposes 60 implemented operations, grouped below into 13 cutover capability groups.

| Capability | HomeMew baseline | Native LifeSpace replacement | Final result |
| --- | --- | --- | --- |
| System probes | health + schema/status | Native Core/Identity health/status | Phase 2 complete; Phase 4 retained |
| User profile | read/update profile; user avatar | Identity profile + user-avatar API | Identity 0.4.0 HomeMew-scoped staging verified |
| Family listing/profile | list/create/read/update family | `Space(kind=family)` | Native Kernel surface accepted; legacy façade absent |
| Members | list/change role/remove/leave | Space membership + linked Space Person | Native Kernel surface accepted; legacy façade absent |
| Invitations | create/list/revoke/preview/join | Core Space invitations | Native Kernel surface accepted; legacy façade absent |
| Family avatar | upload/read URL | Core Space avatar | Native accepted/staging verified |
| Events | CRUD/search/filter + attendees | metadata-driven Event + Calendar Capability + Space Person attendees | Phase 4 accepted/staging verified |
| Tasks | CRUD/search/filter/complete/reopen + assignees | metadata-driven Task + Workflow + Space Person assignees | Phase 4 accepted/staging verified |
| Day records | CRUD/occurrences/archive/restore | metadata-driven Day Record + Temporal Capability | Phase 4 accepted/staging verified |
| Wishes | CRUD + lifecycle | metadata-driven Wish + Policy/Workflow + Space Person refs | Phase 4 accepted/staging verified |
| External integrations | integration/credential lifecycle + OAuth credentials | Identity service principal + `lsp_pat_*` / OAuth; Core Data Grants | Native service-auth surface accepted; credentials rotate rather than copy |
| Creation drafts | async interpretation, polling, choose-kind, cleanup | Registry-driven Creation Draft Queue | Final metadata-driven surface accepted/staging verified |
| Internal user creation | trusted backend user creation | Identity trusted-application user creation/exchange | Identity 0.4.0 HomeMew boundary accepted/staging verified |

### Explicitly absent from the frozen released baseline

There is no implemented anniversary, notification, outbound webhook or general attachment API in the frozen released HomeMew baseline. They are not HomeMew parity blockers unless a later released HomeMew baseline explicitly adds them through the freeze rule.

## Core transformation policies

### Family -> Space

| HomeMew concept | LifeSpace concept | Migration/client rule |
| --- | --- | --- |
| `fam_*` family | `spc_*` `Space(kind=family)` | Explicit deterministic ID mapping; client uses `spaceId` |
| creator/admin | owner/admin membership | Preserve authorized role meaning using deterministic fallback rules |
| member | editor membership | Preserve proven mutation authority unless platform policy intentionally changes |
| represented member | linked Space Person | Domain relationships use Person IDs, not login user IDs |
| family timezone | Space timezone | Preserve IANA timezone |
| max 8 active members | family-kind Space policy | Native platform invariant |
| max 3 created families | HomeMew application policy | Not a generic Core restriction |
| invitation | Space invitation | Native invitation lifecycle + atomic join/reactivation |

### People references

| HomeMew use | Native LifeSpace use |
| --- | --- |
| event attendee user ID | Event attendee Space Person reference from the accepted Model Contract |
| task assignee user ID | Task assignee Space Person reference from the accepted Model Contract |
| day-record `subjectUserId` | Day Record subject Space Person reference from the accepted Model Contract |
| wish owner/claimant/fulfiller user | Wish Space Person refs from the accepted Model Contract |
| authenticated actor | verified credential principal; never a request `userId` |

There is no permanent runtime user-ID-to-Person compatibility façade.

### Profiles and avatars

- Global user profile/avatar ownership is Identity.
- Space avatar ownership is Core.
- R2 keys remain private persistence details; stable Worker URLs are public contract fields.
- JPEG/PNG/WebP and 5 MB validation, safe replacement/rollback and Space optimistic concurrency preserve the required source safety properties.
- HomeMew avatar migration emits deterministic native metadata plus `object-copy-manifest.json`; invalid cross-owner source keys are rejected.

### Service authentication and integrations

- Identity owns `svc_*`, `lsp_pat_*` hash/metadata and optional OAuth client credentials.
- Core owns Space/Data Grant authorization; service principals do not become Space members.
- Opaque PATs are introspected through Core -> Identity Service Binding; OAuth `client_credentials` issues a short-lived JWT for the same principal model.
- Effective authority is credential/application scope ceiling × current Data Grant × model/domain policy.
- Grant/PAT revocation is effective on subsequent requests as staging verified.
- HomeMew integration migration emits service-principal/Data-Grant artifacts and credential-rotation reports. No `hmw_pat_*` plaintext or legacy secret hash is copied.

### Creation Draft / Queue

- Native path remains the Kernel Creation Draft surface under `/api/v1/spaces/{spaceId}/creation-drafts...`.
- Only an active user Space member with `creation-drafts:read/write` may use the interactive flow; service principals are intentionally unsupported.
- Model interpretation is Registry-driven; HomeMew does not maintain a second hard-coded domain contract.
- Job transitions are queue-backed and generation-claimed for retry safety.
- Ambiguous model choice retains short-lived source text only until the user resolves the model and the job is requeued.
- Terminal `ready` / `failed` state erases source input; jobs expire after 24 hours and are physically cleaned hourly.
- Historical HomeMew jobs, in-flight Queue messages and rate-limit counters are ephemeral and are **not migrated**.
- The provider boundary is OpenAI-compatible and environment configured; LifeSpace does not encode a HomeMew-specific model/API key into the platform contract.

### Domain invariants retained

Events, Tasks, Day Records and Wishes retain the approved semantics for search/filter/pagination, date/time rules, optimistic concurrency, soft deletion, audit actor/history and same-Space Person constraints through the final metadata-driven Generic Runtime and Capability engines. The accepted Model Contract revision is authoritative for concrete routes, fields, schemas, query parameters and actions.

## Migration artifacts that remain required

These artifacts belong to the separately planned migration phase; Phase 4 does not create or execute them:

- legacy HomeMew user -> LifeSpace user mapping when IDs change;
- `family_id -> space_id`;
- family member -> membership / Space Person;
- historical actor/person mappings;
- deterministic Event/Task/Day Record/Wish transforms and validation;
- avatar `object-copy-manifest.json` plus object existence/integrity verification;
- external integration -> service principal/Data Grant mapping and credential rotation report;
- migration row-count, referential-integrity and authorization reports.

These artifacts are migration/audit tooling only. They do not justify legacy runtime routes or response translation.

## Target architecture exclusions

The following are explicitly not part of the LifeSpace target:

- HomeMew `/api/v1/families/...` or family-invite runtime routes;
- legacy HomeMew response façades;
- runtime user-ID -> Person translation solely for old clients;
- legacy HomeMew role vocabulary in LifeSpace contracts;
- legacy HomeMew JWT issuer/audience acceptance;
- `hmw_pat_*` treated as LifeSpace credentials;
- historical Creation Draft job/Queue-message migration.

## Accepted HomeMew client contract requirements

The redesigned HomeMew application must:

- pin Identity `0.4.0`, Core Kernel `0.12.0`, Model Contract `mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45` and integration profile version 1; never infer an unversioned latest contract;
- use `spaceId` and native Space/membership APIs rather than HomeMew family compatibility routes;
- resolve/display Space People and send the accepted Model Contract's Person references for domain relationships;
- keep WeChat `openid` and provider mapping in the HomeMew Cloudflare backend;
- let that trusted backend resolve `openid -> LifeSpace usr_*`, authenticate with a server-only `lsa_*`, and exchange for a short-lived app-scoped user token;
- never expose `lsa_*` to the Mini Program or trust a Mini Program-supplied arbitrary LifeSpace user ID;
- use Identity-owned user profile/avatar and Core-owned Space avatar APIs;
- manage owner-controlled and third-party integrations through LifeSpace service principals/credentials/Data Grants according to the service-auth contract;
- use the native Registry-driven Creation Draft API and polling semantics;
- keep HomeMew product-only rules in the HomeMew application boundary.

The UI may continue to present family/member terminology.

## Final parity conclusion

All 13 frozen production capability groups have a tested native LifeSpace replacement and were rechecked against the final Phase-3 metadata-driven runtime during Phase 4. The HomeMew application boundary, least-privilege scopes, Application × Model Access and reproducible contract handoff were staging-verified.

**Phase 2 parity remains complete. Phase 4 Integration Readiness is complete with the accepted contract tuple above. Phase 5 remains separately Planned and is not started by this document.**

## Freeze rule

Any new HomeMew Core capability intended for a released client must include, in the same change:

1. a parity-matrix entry;
2. its final native LifeSpace replacement or explicit application-local decision;
3. migration classification and transform/object/secret impact;
4. required HomeMew client change;
5. whether it changes production cutover scope.

A HomeMew-only feature may not silently expand the platform migration scope, replace an accepted contract pin, or reintroduce legacy runtime compatibility without a new explicit architecture/compatibility decision.
