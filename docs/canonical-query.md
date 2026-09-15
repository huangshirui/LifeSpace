# Canonical Typed Query

## Status and authority

This document is the normative human-readable contract for ordinary LifeSpace model query semantics.

It complements `docs/model-definition-spec.md`:

- Model Definition declares which fields are `searchable`, `filterable` and `sortable`;
- semantic field/range types determine which operators and orderings exist;
- this document defines the one Canonical Query composition model used by Runtime, generated Model Contract, adapters and Agent/MCP projections.

Runtime implementation, automated tests and immutable `mct_*` Model Contract Revisions are executable contract evidence. If they disagree with this document, treat that as contract drift to fix.

The caller-visible concepts **Generic Query** and **Capability Query** are not separate semantic query languages. Calendar/Temporal may own planner/compiler behavior, but callers should converge on one Canonical Query.

## 1. Canonical shape

The semantic pipeline is:

```text
Search
  -> Filter(Boolean AST + typed predicates)
  -> Sort
  -> Cursor Pagination
```

Structured transport:

```http
POST /api/v1/spaces/{spaceId}/models/{modelKey}/records/query
Content-Type: application/json
```

Conceptual request:

```json
{
  "search": { "text": "FTC" },
  "filter": {
    "and": [
      { "field": "status", "op": "eq", "value": "pending" },
      {
        "or": [
          {
            "field": "dueDate",
            "op": "within",
            "value": {
              "kind": "local_date_window",
              "startDate": "2026-09-14",
              "endDateExclusive": "2026-09-21",
              "timezone": "Asia/Shanghai"
            }
          },
          { "field": "dueDate", "op": "isNull" }
        ]
      }
    ]
  },
  "sort": [
    { "field": "dueDate", "direction": "asc" },
    { "field": "name", "direction": "asc" }
  ],
  "page": { "limit": 20, "cursor": null }
}
```

Result envelope:

```json
{
  "items": [],
  "nextCursor": "opaque-cursor-or-null"
}
```

`total` is not part of the default contract.

## 2. Search is retrieval, not a Filter operator

`search` is a first-class top-level query facet. It searches only fields declared by the model as `query.searchable`.

Current matching semantics are model-scoped text retrieval over declared text-like fields. Storage may later use D1 FTS or another index, but indexing strategy is not public semantics.

Search composes with Filter, Sort and Pagination. A consumer must not model keyword retrieval as a synthetic field predicate.

## 3. Filter Boolean AST

Filter is a recursive Boolean expression:

```text
Filter := Predicate
        | { and: Filter[] }
        | { or: Filter[] }
```

Current Runtime limits:

- maximum depth: 8;
- maximum nodes: 100;
- empty Boolean groups are invalid.

`and` and `or` child order is not semantic. Runtime normalizes commutative groups before binding cursor identity, so equivalent reordered Boolean groups remain the same query for pagination purposes.

## 4. Typed predicates

A field may be filtered only when its Model Definition declares it filterable, except platform-projected semantic range targets described below.

Operators are determined by semantic type, not invented by adapters.

### 4.1 Scalar equality

For ordinary scalar fields:

```text
eq
ne
isNull
isNotNull
```

`isNull` / `isNotNull` carry no `value`.

### 4.2 Ordered scalar comparison

For ordered scalar types such as Date, Instant/datetime, integer and number:

```text
lt
lte
gt
gte
```

Date values compare as ISO calendar dates. Instant/datetime values are normalized to an absolute RFC3339 instant before comparison.

### 4.3 Local-date window

Date and Instant/datetime fields support `within` with an explicit local-date window:

```json
{
  "field": "observedAt",
  "op": "within",
  "value": {
    "kind": "local_date_window",
    "startDate": "2026-09-14",
    "endDateExclusive": "2026-09-15",
    "timezone": "Asia/Shanghai"
  }
}
```

The window is half-open `[startDate, endDateExclusive)`.

For a Date field the dates compare directly. For an Instant/datetime field Runtime converts both local date boundaries independently to absolute instants using the explicit IANA timezone, preserving DST correctness. Runtime must not silently use server timezone.

### 4.4 Relations and list membership

The Canonical primitive for Person/record relation membership is:

```text
contains(targetId)
```

For example:

```json
{ "field": "assigneePersonIds", "op": "contains", "value": "per_..." }
```

`containsAny(A,B)` and `containsAll(A,B)` are adapter conveniences, not additional Canonical operators:

```text
containsAny(A,B) = contains(A) OR contains(B)
containsAll(A,B) = contains(A) AND contains(B)
```

This rule applies consistently to `person_list` and `record_list`.

The compatibility alias `me` is accepted only for semantic Person relation roles that explicitly support current-actor resolution, such as Calendar attendees or Temporal subject Person. Runtime resolves it under current Space Person state; adapters must not resolve it by guessing a Person ID.

## 5. Structural range predicates

A model-declared `timeRanges` entry is a semantic query target. Calendar-projected ranges may also provide a semantic target during compatibility migration.

Canonical range operators are:

```text
overlaps
contains
before
after
```

Range operands are explicit:

```json
{ "kind": "date", "start": "2026-09-20", "endExclusive": "2026-09-21" }
```

```json
{
  "kind": "instant",
  "start": "2026-09-20T02:00:00Z",
  "endExclusive": "2026-09-20T03:00:00Z"
}
```

or a `local_date_window` as defined above.

`Range<Date>` does not silently compare with `Range<Instant>`. A `local_date_window` provides the explicit temporal context needed to project to the target range type.

### Direct TemporalRange fields

A Model Definition field with `type: "temporal_range"` may be declared in `query.filterable`. It exposes:

```text
overlaps
contains
before
after
kindIs
isNull / isNotNull  (nullable fields only)
```

A `date` operand compares only Date variants, and an `instant` operand compares only Instant variants. A `local_date_window` deliberately evaluates both branches: its calendar dates compare directly with Date ranges, while Core projects the same boundaries through the supplied IANA timezone before comparing Instant ranges. `kindIs` accepts only `date` or `instant`.

Physical discriminator/start/end columns and their composite index are internal planner details. Discovery and generated Model Contracts expose one logical field and the typed operator set.

### Calendar compatibility projection

Until Event storage is migrated to a direct `TemporalRange` value, a Calendar-backed model exposes the semantic query target `when` inside the structured Canonical Query. Runtime projects the existing timed and all-day Calendar field bindings into one range target.

Examples:

```json
{
  "field": "when",
  "op": "overlaps",
  "value": {
    "kind": "local_date_window",
    "startDate": "2026-09-20",
    "endDateExclusive": "2026-09-21",
    "timezone": "Asia/Shanghai"
  }
}
```

```json
{ "field": "when", "op": "kindIs", "value": "date" }
```

`kindIs=date` means all-day/date range; `kindIs=instant` means timed/instant range. This is a compatibility semantic projection, not permission to treat `isAllDay` as the long-term canonical truth.

## 6. Sort

`sort` is an ordered list of criteria:

```json
[
  { "field": "dueDate", "direction": "asc" },
  { "field": "name", "direction": "desc" }
]
```

Rules:

- model fields must be declared `sortable`;
- envelope `createdAt` and `updatedAt` remain sortable platform fields;
- at most 8 criteria;
- duplicate sort fields are invalid;
- null values sort last for both directions;
- Runtime appends stable record `id` as the final tie-breaker;
- effective sort therefore always defines a total continuation order.

The caller does not need to send the implicit `id` tie-breaker.

### 6.1 TemporalRange sort context

A direct `temporal_range` sort requires one explicit viewing context for the result set:

```json
{
  "context": {
    "viewingTimezone": "Asia/Shanghai"
  },
  "sort": [
    { "field": "when", "direction": "asc" }
  ]
}
```

Runtime projects Date variant boundaries through `context.viewingTimezone`, keeps Instant boundaries absolute, and compares `projectedStart → projectedEnd → id`. NULL remains last in either direction. The context is rejected when no TemporalRange sort is present, preventing unused context from silently changing cursor identity.

Execution uses independently ordered Date, Instant and null streams and merges them by the canonical projected keys. The opaque cursor stores continuation state for each stream and binds the normalized viewing context. The legacy GET transport does not advertise TemporalRange sort because it cannot carry this structured context.


## 7. Cursor pagination

Cursor pagination is the long-term public contract. Cursors are opaque and must not be parsed or edited by clients.

A cursor binds at least:

- normalized Search;
- normalized Filter;
- effective ordered Sort;
- temporal/viewing context embedded in the normalized query;
- continuation sort-key tuple and record ID.

If any bound semantic changes, the cursor is invalid for that request.

Relative phrases such as `today` are not Canonical Query values. An adapter resolves them first to an explicit `local_date_window`; the cursor therefore binds the resolved query, not the phrase.

Pagination guarantees deterministic continuation when query semantics, sort keys and the relevant result ordering do not change. It does not currently promise snapshot consistency under concurrent writes.

## 8. Compatibility GET transport

Existing GET list parameters remain compatibility/shorthand syntax while consumers migrate:

```http
GET /api/v1/spaces/{spaceId}/models/{modelKey}/records?...query parameters...
```

Legacy Generic, Calendar and Temporal parameter forms are not separate semantic authorities. They remain accepted compatibility transports and must converge toward deterministic translation into the Canonical Query/planner semantics.

New generic adapters should prefer the structured query contract when they need nested Boolean expressions or typed range composition. They must not introduce new private query operators to compensate for a missing Core semantic.

## 9. Agent / MCP projection

Agent-facing tools do not need to expose the full recursive AST by default. A generated projection may offer:

- `search`;
- simple AND filters;
- `timeWindow`;
- sort;
- limit/cursor;
- convenience `containsAny` / `containsAll`.

The adapter must deterministically lower those inputs to the same Canonical Query. An advanced structured-filter entry may expose nested Boolean expressions when needed.

Complexity belongs in the platform/compiler rather than being duplicated across n8n, MCP, ALOHA or generated UI.

## 10. Authorization and execution boundary

Query syntax does not grant read authority. Every execution still applies the ordinary LifeSpace authorization intersection and model read policy before returning records.

Query compilation may choose indexes, relation-table predicates, typed columns or Capability-owned planner fragments, but those physical choices must not change observable semantics or become part of caller contracts.

## 11. Implementation state

Implemented in the Canonical Typed Query convergence slice:

- structured `POST .../records/query`;
- Search + nested AND/OR Filter + Sort + cursor composition;
- typed scalar comparisons and null predicates;
- relation/list `contains`;
- local-date-window projection;
- structural time-range predicates;
- direct filterable `TemporalRange` predicates with Date/Instant/local-date-window operands;
- direct TemporalRange sort projection with `context.viewingTimezone` and stream-aware cursor continuation;
- Calendar-backed `when` compatibility projection;
- normalized cursor binding and stable multi-sort continuation;
- ordinary Generic GET parameters deterministically lower into Canonical Query before execution;
- already-issued Generic GET v1/v2 cursors remain temporarily accepted by the legacy executor;
- Calendar/Temporal special GET transports remain on compatibility planners until their computed ordering is representable canonically;
- Runtime Discovery and immutable Model Contract expose the same generated Canonical Query descriptor.

Planned follow-up work, not yet current Model Definition v1 behavior:

- Event migration onto the direct TemporalRange resource shape;
- direct semantic `Location` field storage and `withinDistance` execution;
- physical removal of deprecated legacy GET/Capability Query descriptors after downstream consumers migrate to `query.canonical`;
- Canonical Sort support for Calendar mixed date/instant ordering and Temporal computed ordering, followed by retirement of their compatibility GET planners after migration evidence allows it.
