# Calendar Capability binds canonical TemporalRange

Status: **Accepted**

## Decision

Calendar Capability will support a canonical binding form:

```json
{
  "calendar": {
    "rangeField": "when",
    "attendeePersonField": "attendeePersonIds"
  }
}
```

`rangeField` must name a declared `temporal_range` field. It is mutually exclusive with the legacy split Calendar binding (`allDayField`, timed/all-day start/end fields and timezone fields).

The legacy split binding remains parseable for historical published Model Definitions during migration, but new Event truth will move to one authoritative TemporalRange value. Calendar contributes calendar semantics over that value; it no longer owns a private time value representation.

## Rationale

This keeps Model Definition field semantics authoritative, removes `isAllDay` as a second source of truth, reuses the already-shipped TemporalRange CRUD/query/sort implementation, and lets historical Event model revisions remain readable while Event vNext is prepared.

## Compatibility

Historical published Model Definitions may continue to expose the legacy split Calendar binding while they remain supported. New model semantics should use the canonical `temporal_range` binding and must not introduce a second authoritative time representation.
