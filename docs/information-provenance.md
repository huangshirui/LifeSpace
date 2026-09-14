# Information Provenance

Status: **V0.1 implementation contract**

Information Provenance records where durable information itself came from. It is distinct from operation attribution, which records whose authority was exercised and who/what executed a Change.

```text
Operation Attribution
  principal / actor / application / delegation

Information Provenance
  source / sourceRef / derivedFrom
```

## Boundary

Provenance is platform-owned Generic Resource envelope metadata. It is not an ordinary Model Definition field and must not be copied into every domain model.

V0.1 supports:

- accepting Provenance alongside ordinary resource create/update input;
- persisting Provenance by resource version;
- returning the effective Provenance from a single-record GET;
- preserving the previous effective Provenance when an update does not supply a replacement.

V0.1 deliberately does **not** support:

- Canonical Query Filter/Search/Sort over Provenance;
- field-level lineage;
- automatic dereferencing of source references;
- external-system synchronization semantics;
- cross-Space authority traversal through a provenance reference;
- provenance-only PATCH operations.

A future queryable provenance surface requires a concrete use case and an explicit Canonical Query contract change.

## Envelope

```json
{
  "provenance": {
    "source": "document_extraction",
    "sourceRef": {
      "type": "external",
      "system": "medical-report",
      "ref": "report-2026-09-11#p12"
    },
    "derivedFrom": [
      {
        "type": "record",
        "recordId": "rec_example",
        "version": 2
      }
    ]
  }
}
```

`source` is a bounded non-empty source category/name. V0.1 intentionally does not define a platform enum: values such as `user_input`, `ai_estimation`, `document_extraction` or `external_sync` are producer semantics, not a closed ontology.

`sourceRef` is an optional reference to the primary original material or system item. `derivedFrom` is an optional ordered list of upstream inputs used to derive the information.

## Reference shapes

A LifeSpace record reference is evidence only:

```json
{
  "type": "record",
  "recordId": "rec_example",
  "version": 2
}
```

`version` is optional. V0.1 validates only the structural `rec_*` identifier shape and positive version. It does not perform a target lookup, enforce same-Space membership, or grant read authority to the referenced record.

An external reference is opaque to Core:

```json
{
  "type": "external",
  "system": "aloha",
  "ref": "upload/img_001"
}
```

Core preserves the reference but does not fetch, authenticate to, or interpret the external system.

## Version semantics

Physical persistence is sparse and version-aware:

```text
resource_provenance
  (record_id, record_version) -> provenance revision
```

A row is written only when Provenance is explicitly supplied for a resource version. If later resource versions do not replace it, their effective Provenance is the latest stored revision whose `record_version <= current resource version`.

This avoids duplicating unchanged evidence while preserving the point at which provenance changed.

## Read projection

Single-record GET returns effective Provenance when present. The Generic Runtime resolves it in the same typed-resource read query, so Provenance does not add another Worker-to-D1 round trip.

Collection list/query paths do not hydrate Provenance in V0.1. This both preserves the current list I/O budget and prevents Provenance from becoming an accidental query surface before its semantics are deliberately designed.

## Mutation and policy

Provenance is envelope metadata, so it is removed from ordinary model data before Model Definition field validation and Model Policy input evaluation. Existing ordinary-model read/write authority still governs the resource mutation; Provenance introduces no new permission bypass.

When Provenance is supplied, persistence must be coupled to the successful resource mutation. A stale optimistic-concurrency update must not create a provenance revision.

## Relationship to AI-derived data

AI-derived observations or assessments may use `source` and `sourceRef` to remain distinguishable from authoritative/user-entered information. `derivedFrom` can preserve upstream LifeSpace records used to make a derivation without turning the derivation into a hidden copy of those records.

The presence of Provenance does not itself declare truth quality, confidence, medical authority, or trust level. Those are separate domain semantics where required.
