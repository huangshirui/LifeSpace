# Event → TemporalRange Phase 4 implementation plan

Status: **Active development; production cutover blocked while HomeMew Mini 1.6.3 is under review**

Tracking: #234

## Goal

Migrate the baseline `event` model from split Calendar-owned time truth (`isAllDay`, timed start/end/timezones, all-day start/end) to one authoritative `when: temporal_range` field while preserving half-open interval semantics and keeping Calendar as a reusable capability over the canonical range.

## Development slices

### Phase 4A — Canonical Calendar binding

- [x] extend Calendar Capability metadata to accept `rangeField` bound to a declared `temporal_range` field;
- [x] reject mixed canonical + legacy Calendar bindings;
- [ ] update runtime/contract/query code paths to understand canonical binding without breaking historical published definitions;
- [ ] add positive and deny-path tests;
- [ ] update Model Definition and time-space docs.

### Phase 4B — Event vNext contract + storage migration

- [ ] change shipped baseline Event definition to required `when: temporal_range`;
- [ ] publish as an explicitly breaking Event Model Definition version;
- [ ] generate deterministic typed storage for the new schema;
- [ ] backfill every existing Event record from the old split fields into canonical TemporalRange;
- [ ] prove date/all-day and instant/timed mappings preserve `[start,end)` semantics;
- [ ] fail migration on malformed/ambiguous legacy rows rather than silently reinterpret them.

### Phase 4C — Query and application cutover preparation

- [ ] retire Calendar-owned compatibility `when` projection for the new Event definition;
- [ ] use native TemporalRange filter/sort/local-date-window semantics;
- [ ] prepare HomeMew BFF new Event adapter and HomeMew Web new contract consumption;
- [ ] assess ALOHA / n8n / MCP generated consumer impact and required releases.

## Production gate

Phase 4 production mutation is a **multi-evidence hard gate**, not just a WeChat-review gate. Development, CI, disposable/staging migrations, draft PRs and application-adapter preparation may proceed while the gate is closed, but no production migration/deploy is allowed until every item below is satisfied.

### G1 — Reviewed Mini is production-active

- HomeMew Mini 1.6.3 is approved by WeChat and is production-active.
- The reviewed Mini still speaks the frozen final HomeMew BFF contract; Phase 4 must not require another Mini wire-contract migration.

### G2 — Final LifeSpace candidate is immutable and on `main`

- the final Event v6 / TemporalRange candidate has passed repository CI and is merged to `main`;
- staging/APAC/production workflows pin `actions/checkout` to the workflow event's immutable `github.sha`, never moving `main` during a re-run;
- the checked-out Git SHA must equal `GITHUB_SHA` before release evidence is accepted.

### G3 — Live staging is the same semantic candidate

Before APAC timing starts, the gate must prove live staging matches the checkout candidate:

- Core and Identity `environment`, schema version and contract version equal checkout expectations;
- proving-model Registry schema hashes equal checkout expectations;
- the active immutable `mct_*` Model Contract agrees with the current published proving models;
- the authenticated Model Admin view agrees with the same candidate.

A successful timing run against stale or semantically different staging is invalid evidence.

### G4 — Fresh same-SHA APAC performance gate passes

- dispatch a **new** `APAC performance gate` run from `main` for the final candidate SHA;
- the run must complete successfully for that exact SHA and repository;
- production accepts only a gate started within the previous 24 hours;
- acceptance targets remain common-read **P50 <= 220 ms** and **P90 <= 500 ms**;
- the representative Event read must exercise Event v6 through Canonical Query (`when overlaps local_date_window`, structured `sort`, `context.viewingTimezone`), not a retired Calendar query alias.

Run #14 is retained as useful engineering evidence only. After the Event-v6 benchmark fix it measured Event Canonical Query at P50 90 ms / P90 102 ms, but the run was originally dispatched at `cd25c8b` while a later re-run checked out newer moving `main`; therefore it must **not** authorize final production cutover. The final candidate requires a new dispatch after the corrected immutable-SHA gate is on `main`.

### G5 — Migration/backfill evidence is complete

- disposable/staging migration proves every legacy Event maps deterministically to canonical `when` while preserving `[start,end)` semantics;
- malformed or ambiguous legacy rows fail closed rather than being silently reinterpreted;
- post-migration Registry/model-contract/schema verification passes;
- rollback or forward-fix procedure is documented for failures before and after the breaking model publication point.

### G6 — HomeMew adapter release is compatible

- HomeMew BFF is ready for the new LifeSpace upstream contract while keeping the Mini-facing contract unchanged;
- the LifeSpace + BFF release order is compatibility-preserving for the coordinated cutover window;
- no production step depends on changing the reviewed Mini again.

### G7 — Production workflow enforces the evidence before mutation

- production deployment is launched from `main` for the exact candidate SHA;
- the operator supplies the successful APAC workflow run ID;
- the workflow verifies workflow identity, explicit dispatch, success, branch, repository, exact `head_sha` and freshness **before any production migration or deployment step**;
- stale, failed, mismatched-SHA or mismatched-repository APAC evidence blocks production automatically.

## Production cutover sequence after the gate opens

1. finalize/rebase the Phase 4 implementation on current `main`, pass full repository CI, and merge the intended release candidate;
2. deploy that candidate to staging and complete staging semantic/migration verification;
3. dispatch a new APAC performance gate for that exact `main` SHA and retain the successful run ID;
4. verify HomeMew BFF compatibility/release readiness without changing the frozen Mini contract;
5. execute the production migration/deploy workflow with the exact APAC run ID so the machine gate re-verifies the evidence before mutation;
6. complete production semantic/model-contract/HTTP checks and the coordinated HomeMew BFF cutover;
7. only after production verification, remove obsolete BFF upstream compatibility/fallback code in the later cleanup phase; Mini remains unchanged.

## Current exact next action

Keep PR #252 draft and production-blocked. First land the exact-candidate APAC/production hard-gate infrastructure, then continue non-production Event v6 verification. After HomeMew Mini 1.6.3 is approved and production-active, refresh the final candidate on `main`, deploy that exact SHA to staging, and generate a **new** same-SHA APAC acceptance run before any production mutation.
