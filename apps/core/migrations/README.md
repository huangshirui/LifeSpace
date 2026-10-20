# Core D1 Migrations

Numbered Core database migrations will live here once implementation begins.

Migration history is append-only after deployment. Do not edit an already-applied production migration to change its meaning; add a new migration instead.


## 0057 Recurrence rollout

Preserve canonical Core-first → Identity rollout. Apply Core migrations in numeric order (0054 Relations, 0055 External, 0056 Relation integrity, 0057 Recurrence, 0058 review fixes), deploy Core, then deploy Identity 0.12.0. New generation fails closed until current-root introspection is available. Task subject/occurrence columns preserve existing data; the catalog snapshot is compatible and prior Registry/Contract history remains. Recurrence tables/indexes are capability projections, not per-business-model CRUD tables. Rollback pauses Plans/rolls back Workers and retains additive migrations; never delete history as a rollback shortcut.

## 0058 Runtime review fixes / 审核修复

Adds the indexed executable External refresh queue and Source disable/reactivate lifecycle, plus a commit-time guard against deleting the current completion-based Task. Historical generated Tasks remain deletable; cancel/skip/removing the recurrence rule remain explicit operations. Apply this additive migration before the integrated Worker; do not edit historical migration snapshots.

## 0059–0061 External business bindings / 外部业务绑定

Continue numeric order after 0058: 0059 binds a published External business definition to one active Space registration; 0060 extends the semantic junction to external identity metadata while retaining Native live-endpoint and atomic cleanup guards; 0061 adds bounded identity-presence observation and lifecycle queue parking. Existing payloads and Native history are retained. Apply all three before the integrated Core Worker. No Provider payload is copied into D1. Provider writes and local links have separate failure boundaries; rollback requires pausing affected bindings and retaining migration history. Staging must verify the exact candidate and isolated Provider Service Binding/Secrets before production rollout.

## 0062 Definition queue lifecycle / 定义生命周期调度

Parks existing schema work for retired External definitions, parks future retire operations, and resumes eligible schema/identity work after same-origin republication. Source reactivation retains the published-definition gate; legacy untyped registrations remain executable. Apply after 0061 before the repaired Worker. It retains bindings, observed identities, Provider records and Registry history; no Provider write or secret migration occurs.

## 0068 External record identity ownership / 外部记录身份归属

Existing External record IDs and mappings remain unchanged. Add a BEFORE INSERT trigger on `external_record_identities` so an Adapter cannot silently reuse a global recordId already owned by another External binding or source Space. Same-owner UPSERT remains allowed. The trigger executes inside the existing D1 audit/identity batch, without another Worker↔D1 round trip. A collision is an opaque contract failure on reads and an unknown write outcome after Provider mutation; never retry an uncertain Provider write automatically. Apply this migration before the corresponding Core Worker. No Provider data or bytes are copied or migrated.

## 0069 Record Icon one-time cutover / 图标元数据迁移

User-approved BREAKING migration. The migration adds `resource_records.icon_json`, copies
nonempty `mdl_day_record.icon` values into `{"type":"emoji","value":"…"}`, removes
`mdl_day_record.icon`, and publishes Baseline DayRecord version 6 with the new
hash `3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7`.
Before applying in production, audit nonempty historical DayRecord icon strings:
unsupported non-Emoji values must be corrected before destructive migration.
Back up the production D1 database and perform an explicit Staging migration
and data-count/identity verification before the manually approved rollout.
Old HomeMew Mini clients are intentionally unsupported for the Days surface
during WeChat review. Do NOT implement a protocol compatibility layer.
