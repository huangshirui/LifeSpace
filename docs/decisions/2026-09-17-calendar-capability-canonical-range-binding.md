# Calendar Capability binds canonical TemporalRange

Status: **Accepted for Phase 4 development**

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

## Release boundary

This decision authorizes branch/PR/test implementation during HomeMew Mini 1.6.3 review. It does not authorize production cutover. Production Event contract/storage migration remains gated on the reviewed Mini version becoming production-active.
