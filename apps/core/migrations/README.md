# Core D1 Migrations

Numbered Core database migrations will live here once implementation begins.

Migration history is append-only after deployment. Do not edit an already-applied production migration to change its meaning; add a new migration instead.


## 0057 Recurrence rollout

Deploy Identity 0.12.0 (current-root introspection) first, then apply additive Core migration 0057, then deploy the Core candidate. Task subject/occurrence columns preserve existing data; the catalog snapshot is compatible and prior Registry/Contract history remains. Recurrence tables/indexes are capability projections, not per-business-model CRUD tables. Rollback pauses Plans/rolls back Workers and retains the additive migration; never delete history as a rollback shortcut.
