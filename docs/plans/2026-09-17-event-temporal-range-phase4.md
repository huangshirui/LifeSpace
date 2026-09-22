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
- staging and production workflows pin `actions/checkout` to the workflow event's immutable `github.sha`; the APAC prerequisite is now an in-workflow production job using that same immutable SHA, never moving `main` during a re-run;
- the checked-out Git SHA must equal `GITHUB_SHA` before release evidence is accepted.

### G3 — Live staging is the same semantic candidate

Before APAC timing starts, the gate must prove live staging matches the checkout candidate:

- Core and Identity `environment`, schema version and contract version equal checkout expectations;
- proving-model Registry schema hashes equal checkout expectations;
- the active immutable `mct_*` Model Contract agrees with the current published proving models;
- the authenticated Model Admin view agrees with the same candidate.

A successful timing run against stale or semantically different staging is invalid evidence.

### G4 — Same-SHA APAC performance prerequisite passes

- `Deploy production` automatically runs its `apac_performance` prerequisite job after explicit production-intent validation and before any production mutation;
- the APAC job checks out the exact production workflow `github.sha` and proves live staging matches that candidate before timing begins;
- acceptance targets remain common-read **P50 <= 220 ms** and **P90 <= 500 ms**;
- the representative Event read must exercise Event v6 through Canonical Query (`when overlaps local_date_window`, structured `sort`, `context.viewingTimezone`), not a retired Calendar query alias;
- there is no operator-supplied APAC run ID or freshness handoff: the evidence is generated inside the same production workflow run immediately before the production job.

Run #14 remains useful historical engineering evidence only. After the Event-v6 benchmark fix it measured Event Canonical Query at P50 90 ms / P90 102 ms, but it cannot authorize a later production release. Every production dispatch generates fresh same-SHA APAC evidence before mutation.

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
- a validation job checks the explicit production confirmation and `main` branch before the APAC probe starts;
- the `apac_performance` job proves candidate identity and latency against live staging for that same `github.sha`;
- the production mutation job has `needs: apac_performance`, so a failed or semantically mismatched staging/APAC gate blocks all production migration and deployment automatically.

## Production cutover sequence after the gate opens

1. finalize/rebase the Phase 4 implementation on current `main`, pass full repository CI, and merge the intended release candidate;
2. deploy that exact candidate to staging and complete staging semantic/migration verification;
3. verify HomeMew BFF compatibility/release readiness without changing the frozen Mini contract;
4. dispatch `Deploy production` from that exact `main` SHA; its APAC prerequisite job automatically proves live staging candidate identity and latency before any production mutation;
5. after the APAC prerequisite passes, the production job performs migration/deploy plus semantic/model-contract/HTTP verification;
6. complete the coordinated HomeMew BFF cutover;
7. only after production verification, remove obsolete BFF upstream compatibility/fallback code in the later cleanup phase; Mini remains unchanged.

## Current exact next action

Keep the release production-blocked until the intended candidate is merged to `main`, deployed as that exact SHA to staging and downstream compatibility is ready. Production is then dispatched once; its built-in APAC prerequisite generates fresh same-SHA acceptance evidence automatically before any production mutation.
