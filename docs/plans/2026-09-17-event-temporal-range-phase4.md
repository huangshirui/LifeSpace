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

### Production gate

No Phase 4 production cutover until HomeMew Mini 1.6.3 is approved and production-active. Development, CI, migrations against disposable/staging databases, draft PRs and application adapter preparation may proceed in parallel.

## Current exact next action

Complete Phase 4A on branch `phase4/event-temporal-range-prep-2026-09-17`, keep the PR draft, and use CI to discover every runtime/contract path that still assumes split Calendar fields.
