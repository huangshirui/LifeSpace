# Time and Space Semantics

## Status and authority

This document defines LifeSpace platform-level time and location semantics used by Model Definition, Canonical Query, Runtime projections and generated contracts.

It deliberately separates semantic truth from current storage compatibility. Sections marked **Current** describe behavior implemented by the present Runtime/Model Definition generation. Sections marked **Planned** describe an approved target that still requires a compatibility-classified Model Definition/storage migration before it becomes available to published models.

`docs/canonical-query.md` defines how these semantic values participate in Search / Filter / Sort / Cursor Pagination.

## 1. Time value system

### 1.1 Instant

An Instant is one absolute point on the timeline.

Current Model Definition v1 represents this semantic type as `datetime`. Runtime accepts RFC3339 date-time input and normalizes it to an absolute ISO instant.

An Instant must never be interpreted using server-local timezone after it has been stored. Presentation timezone is context, not a mutation of the stored instant.

### 1.2 Date

A Date is an ISO calendar date `YYYY-MM-DD` with no time-of-day and no inherent timezone.

A stored Date must not be silently converted to an Instant. Conversion requires an explicit temporal context such as an IANA timezone and a defined boundary rule.

### 1.3 IANA timezone

Timezone values use IANA timezone identifiers. They are required wherever local calendar boundaries must be projected onto absolute time.

A viewing timezone is interpretation/presentation context. It does not rewrite the timezone or absolute value of an existing record.

Canonicalization of accepted IANA aliases/casing is tracked separately from these semantics; all boundaries must use one shared Core timezone normalization rule when that work lands.

## 2. Range semantics

A semantic range has:

```text
start
end
bounds
value type
```

The preferred ordinary interval convention is half-open `[start, end)` because adjacent intervals do not overlap by sharing an endpoint.

Current Model Definition supports structural `timeRanges` over two Date fields or two datetime/Instant fields, with explicit bounds. Calendar also projects its existing timed and all-day field pairs as structural time ranges.

A structural range declaration gives meaning to a field pair; it is not merely UI grouping and it does not imply arbitrary cross-type comparison.

## 3. Controlled TemporalRange

**Planned canonical value type.**

TemporalRange is a controlled temporal union for values that can be either all-day/date-based or timed/instant-based. It is intentionally not a general arbitrary union type.

Conceptually:

```json
{
  "kind": "date",
  "start": "2026-09-20",
  "endExclusive": "2026-09-21"
}
```

or:

```json
{
  "kind": "instant",
  "start": "2026-09-20T02:00:00Z",
  "endExclusive": "2026-09-20T03:00:00Z"
}
```

For Event-like calendar occurrences this is the long-term source of truth. `isAllDay` is not intended to remain an independent truth alongside the range variant.

### Current Calendar compatibility

The current Event model still persists the existing Calendar fields:

- `isAllDay`;
- timed `startAt` / `endAt` plus record timezones;
- all-day `startDate` / `endDateExclusive`.

Changing the published Event model directly to a single TemporalRange field would be a breaking schema/storage/downstream transition. Therefore the Canonical Query Runtime currently projects those existing Calendar bindings to a semantic `when` range target rather than silently changing the resource shape.

That compatibility projection lets query semantics converge first while resource migration remains explicit and reversible.

## 4. Local-date windows

A local-date window is explicit query context:

```json
{
  "kind": "local_date_window",
  "startDate": "2026-09-20",
  "endDateExclusive": "2026-09-21",
  "timezone": "Asia/Shanghai"
}
```

Semantics are `[startDate, endDateExclusive)` in the supplied timezone.

Projection rules:

- target `Range<Date>`: compare the calendar dates directly;
- target `Range<Instant>`: independently convert each local date boundary to an absolute instant using the IANA timezone;
- target Date scalar with `within`: compare directly to the date window;
- target Instant scalar with `within`: compare to the absolute projected window.

This boundary conversion is DST-safe; one local day is not assumed to be exactly 24 hours.

`Range<Date>` and `Range<Instant>` have no implicit direct comparison semantics. Cross-granularity comparison requires an explicit projection context such as `local_date_window`.

Relative phrases such as `today`, `thisWeek` or `nextMonth` are adapter/application language. They must be resolved to explicit dates and timezone before Canonical Query execution.

## 5. Range query operators

Canonical Query uses typed range predicates:

```text
overlaps
contains
before
after
```

For Calendar-backed compatibility `when`, the same operators apply over the projected all-day/timed branches.

`kindIs` may be used on that controlled TemporalRange projection:

```text
kindIs = date
kindIs = instant
```

This distinguishes date/all-day and instant/timed variants without exposing physical discriminator columns as public contract.

## 6. Temporal sorting

Sorting a controlled temporal value requires a projection that produces comparable ordering keys.

Long-term rule:

```text
projectedStart -> projectedEnd -> record id
```

For mixed Date/Instant temporal ranges, Runtime must not silently adopt a server timezone. A viewing timezone or other explicit temporal context is required when Date values need projection into the same absolute ordering domain as Instant values.

Current legacy Calendar `calendarStart` ordering remains a compatibility behavior. New query work should converge on Canonical Query semantic sort projection rather than create another Calendar-only sort language.

## 7. Location

### 7.1 Canonical semantic value

**Planned Model Definition field type.**

Location is a semantic value, not merely a display string. It supports bounded precision:

```json
{ "name": "文来中学" }
```

or:

```json
{
  "name": "文来中学",
  "coordinates": { "latitude": 31.0, "longitude": 121.0 }
}
```

The precise schema will be versioned in Model Definition before publication. Coordinates are authoritative only when explicitly present in the stored value or supplied through an approved write path.

A name-only Location must not be silently geocoded by Core. Future geocoding is a separate capability/service and must not mutate the meaning of the original value without an explicit write.

### 7.2 Spatial query

Where a Location has coordinates, Canonical Query will support typed spatial predicates such as:

```text
withinDistance(point, distance)
```

Example conceptual predicate:

```json
{
  "field": "location",
  "op": "withinDistance",
  "value": {
    "point": { "latitude": 31.0, "longitude": 121.0 },
    "meters": 500
  }
}
```

This is **planned** until the direct Location field type and storage/query compiler are implemented.

D1 remains the preferred storage engine. A geohash or other spatial index may be used internally for candidate reduction, but it is an implementation detail and must not enter Model Definition, Canonical Value, REST or Agent Tool contracts.

## 8. Seven-layer responsibility split

Time and space semantics follow the same platform layering as Canonical Query:

1. **Domain semantics / type system** — defines Instant, Date, ranges, controlled TemporalRange and Location meaning.
2. **Model Definition DSL** — declares fields and structural semantic bindings; it does not contain SQL/index logic.
3. **Canonical Value / Query Model** — carries unambiguous stored/query values and typed predicates.
4. **REST / generated contract transport** — transports those values without inventing parallel semantics.
5. **Runtime / Query Planner** — performs timezone/range/spatial projection and selects execution strategy.
6. **Storage / Index** — typed D1 columns, relation tables and optional internal temporal/spatial indexes.
7. **Resource / Query Result Projection** — returns canonical or consumer-specific projections without leaking storage discriminators.

A lower layer may optimize execution but must not change the semantics defined above.

## 9. Agent and MCP projection

Agents should receive business-readable shapes rather than storage unions or planner details.

Timed occurrence example:

```json
{
  "when": {
    "kind": "timed",
    "start": "2026-09-20T10:00:00+08:00",
    "end": "2026-09-20T11:00:00+08:00"
  }
}
```

All-day example:

```json
{
  "when": {
    "kind": "all_day",
    "startDate": "2026-09-20",
    "endDateExclusive": "2026-09-21"
  }
}
```

A local time without an offset is insufficient by itself; the adapter must also have an explicit IANA timezone and deterministically convert it before sending Canonical Instant semantics.

Agent query tools may expose a simple `timeWindow` object and lower it to `local_date_window` + the corresponding Canonical range predicate. Agents do not need to manipulate planner/storage discriminators.

## 10. Migration boundary

The semantic decisions in this document are approved, but deployment must preserve published-model compatibility.

Current convergence order:

1. establish one Canonical Typed Query and explicit local-date/range semantics;
2. project existing Calendar Event storage into the canonical query target during transition;
3. publish direct TemporalRange and Location Model Definition support only with compatibility classification, storage plan, generated-contract changes and downstream impact assessment;
4. migrate Event and consumers explicitly;
5. retire old Calendar/Temporal query transports only after consumer/traffic evidence permits removal.

Do not use an implementation shortcut to turn a semantic migration into an unannounced breaking model publication.
