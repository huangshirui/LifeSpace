# Time and Space Semantics

## Status and authority

This document defines LifeSpace platform-level time and location semantics used by Model Definition, Canonical Query, Runtime projections and generated contracts.

It deliberately separates semantic truth from current platform and application migration state. Sections marked **Current** describe behavior implemented by the present Runtime/Model Definition generation. Sections marked **Planned** describe an approved target that still requires Query, compatibility-classified model migration, or downstream application work.

`docs/canonical-query.md` defines how these semantic values participate in Search / Filter / Sort / Cursor Pagination.

## 1. Time value system

### 1.1 Instant

An Instant is one absolute point on the timeline.

Canonical Model Definition syntax represents this semantic type as `instant`. Runtime accepts only absolute RFC3339 input carrying `Z` or a numeric offset and normalizes it to an ISO Instant.

Already-published Model Definition v1 rows may still contain the historical spelling `datetime`. That spelling is a compatibility token only: Registry/runtime loaders continue to interpret it as the same Instant semantic so existing schema hashes remain stable, but new models and newly introduced fields must use `instant`. The controlled TemporalRange canonical value likewise uses `kind: "instant"`; `datetime` is never a TemporalRange variant tag.

An Instant must never be interpreted using server-local timezone after it has been stored. Presentation timezone is context, not a mutation of the stored instant.

### 1.2 Date

A Date is an ISO calendar date `YYYY-MM-DD` with no time-of-day and no inherent timezone.

A stored Date must not be silently converted to an Instant. Conversion requires an explicit temporal context such as an IANA timezone and a defined boundary rule.

### 1.3 IANA timezone

Timezone values use IANA timezone identifiers. They are required wherever local calendar boundaries must be projected onto absolute time.

A viewing timezone is interpretation/presentation context. It does not rewrite the timezone or absolute value of an existing record.

**Current canonicalization rule:** Core trims an accepted timezone input, validates it with the runtime IANA timezone database and canonicalizes it to `Intl.DateTimeFormat(...).resolvedOptions().timeZone`. Space writes, ordinary `timezone` model fields, Canonical Query/local-date-window inputs, Calendar compatibility inputs and product-side creation interpretation viewing context use the same primitive. Adapters must not maintain an independent alias/casing table.

The exact canonical name of an IANA Link alias follows the supported runtime/ICU timezone database rather than a LifeSpace-maintained alias list. Existing valid persisted timezone strings are not bulk-rewritten solely for this representational convergence: new writes and later updates are canonicalized, while historical values remain valid interpretation inputs. A targeted data backfill is required only if an inventory finds a deployed model whose pre-existing non-canonical timezone field must participate in exact-value equality before that record is next written.

## 2. Range semantics

`Range<T>` is a first-class logical value constructor over one base time type:

```text
Range<Date>
Range<Instant>
```

Canonical Model Definition syntax is:

```text
range<date>
range<instant>
```

Canonical value shape is one field value:

```json
{ "start": "...", "endExclusive": "..." }
```

The field type determines whether the boundaries are Date or Instant. Fixed Range values do not repeat a `kind` discriminator. Their bounds are always half-open `[start,endExclusive)`.

Storage may split one logical Range into typed start/end columns, but those columns are an implementation detail. Model authors and callers do not declare or manipulate physical start/end columns merely to represent one Range value.

The existing top-level `timeRanges` structure is **legacy structural compatibility**, not a second canonical Range syntax. It remains readable only for already-published definitions whose two scalar fields were historically given interval meaning. New or changed `timeRanges` declarations are not publishable; new range-valued state uses a first-class Range field.

Calendar split-field projections remain a separately tracked compatibility path until their own migration completes. They do not redefine ordinary `Range<T>`.

## 3. Controlled TemporalRange

**Current platform value, filter and sort type; Event migration remains planned.**

TemporalRange is a controlled temporal union for values that can be either all-day/date-based or timed/instant-based. It is intentionally not a general arbitrary union type. Model Definition v1 can publish a `temporal_range` field for generic CRUD: generated contracts expose the canonical tagged value, while the storage layer dehydrates/hydrates its internal multi-column representation. A filterable field supports typed range predicates and `kindIs`; a sortable field uses an explicit viewing-timezone projection. Migration of the published Event resource shape remains a separate later phase.

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
- target Instant scalar with `within`: compare to the absolute projected window;
- target TemporalRange with a range predicate: evaluate the Date variant against calendar dates and the Instant variant against independently projected absolute boundaries.

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

For a direct filterable `range<date>` or `range<instant>`, the operators apply to the one stored fixed Range value. For a direct filterable `temporal_range`, they apply to its stored Date or Instant variant. For Calendar-backed compatibility `when`, the same operators apply over the projected all-day/timed branches.

`kindIs` may be used on either a direct controlled TemporalRange field or the Calendar compatibility projection:

```text
kindIs = date
kindIs = instant
```

This distinguishes date/all-day and instant/timed variants without exposing physical discriminator columns as public contract.

## 6. Temporal sorting

Sorting a controlled temporal value requires a projection that produces comparable ordering keys.

Current Canonical Query rule:

```text
projectedStart -> projectedEnd -> record id
```

For mixed Date/Instant temporal ranges, Runtime never adopts a server timezone. Canonical Query requires `context.viewingTimezone`; Date boundaries project through that IANA timezone while Instant boundaries remain absolute. NULL stays last for both directions. The opaque cursor binds the normalized context and keeps independent Date/Instant/null stream continuations so pagination remains deterministic.

Current legacy Calendar `calendarStart` ordering remains a compatibility behavior until Event and its consumers migrate to the direct field.

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
2. **Model Definition DSL** — declares first-class semantic field types such as `instant`, `date`, `range<instant>`, `range<date>` and `temporal_range`; it does not expose physical start/end/discriminator columns or SQL/index logic.
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
3. keep canonical `instant`, fixed Range and direct TemporalRange Model Definition/storage/CRUD/query semantics aligned; legacy `datetime` / `timeRanges` remain compatibility-only rather than alternate design paths; introduce Location only with its own storage, generated-contract and downstream impact assessment;
4. migrate Event and consumers explicitly;
5. retire old Calendar/Temporal query transports only after consumer/traffic evidence permits removal.

Do not use an implementation shortcut to turn a semantic migration into an unannounced breaking model publication.
