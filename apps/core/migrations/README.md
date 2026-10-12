# Core D1 Migrations

Numbered Core database migrations will live here once implementation begins.

Migration history is append-only after deployment. Do not edit an already-applied production migration to change its meaning; add a new migration instead.


## 0057 Recurrence rollout

Preserve canonical Core-first → Identity rollout. Apply Core migrations in numeric order (0054 Relations, 0055 External, 0056 Relation integrity, 0057 Recurrence, 0058 review fixes), deploy Core, then deploy Identity 0.12.0. New generation fails closed until current-root introspection is available. Task subject/occurrence columns preserve existing data; the catalog snapshot is compatible and prior Registry/Contract history remains. Recurrence tables/indexes are capability projections, not per-business-model CRUD tables. Rollback pauses Plans/rolls back Workers and retains additive migrations; never delete history as a rollback shortcut.

## 0058 Runtime review fixes / 审核修复

Adds the indexed executable External refresh queue and Source disable/reactivate lifecycle, plus a commit-time guard against deleting the current completion-based Task. Historical generated Tasks remain deletable; cancel/skip/removing the recurrence rule remain explicit operations. Apply this additive migration before the integrated Worker; do not edit historical migration snapshots.
