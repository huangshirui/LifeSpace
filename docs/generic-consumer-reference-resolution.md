# Generic Consumer Reference Resolution v1

Status: **Candidate / Public representation**  
Kernel contract: **0.29.0**  
Semantic owner: `docs/generic-consumer-contract.md` §5–7  

This document fixes the HTTP representation for bounded Batch Reference Resolution / Hydration under the generic consumer contract. It does not redefine mutation authority: lookup/resolution remain Context Projection only.

## Operation

```http
POST /api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}
Content-Type: application/json

{"ids":["per_a","per_b"]}
```

The source Space, published model and relation field determine relation kind and target semantics. The caller cannot provide an arbitrary target model or target type.

Before any target resolution, Core applies the same source-projection gate as Relation Target Lookup:

```text
current source-model read authority
∩ current source-model read Policy
```

Failure of that whole-operation gate is a request-level denial. Per-target opacity applies only after the caller is allowed to use the source relation projection.

## Request

The JSON body is closed and contains exactly one field:

```json
{
  "ids": ["per_a", "per_b"]
}
```

Rules:

- `ids` is required and must be an array;
- minimum 1 item;
- maximum **50** input positions;
- each item is a non-empty string valid for the source relation kind (`per_*` for `person` / `person_list`, `rec_*` for `record` / `record_list`);
- duplicate IDs are allowed;
- input order and duplicate multiplicity are preserved in the response;
- implementation may de-duplicate IDs internally before the set-based target read.

The 50-ID ceiling leaves substantial margin below the repository's 100-binding single-statement performance budget while matching the current default Relation Target Lookup page size.

Malformed structure or invalid ID syntax fails before target lookup.

## Response

For each input position, return exactly one item in the same position:

```json
{
  "data": {
    "items": [
      {"id":"per_a","status":"resolved","label":"Alice"},
      {"id":"per_b","status":"unavailable"}
    ]
  }
}
```

Item union:

```text
resolved
  -> id + status="resolved" + minimal canonical label

unavailable
  -> id + status="unavailable"
```

`unavailable` has no reason/detail field and MUST NOT distinguish target missing, deleted, wrong Space, hidden, forbidden or otherwise unresolved state. The ID is echoed only because it was already caller-supplied.

## Person v1

`person` and `person_list` are supported immediately because Space Person already owns one canonical reference label: `displayName`.

The target read is restricted to active `space_people` in the source Space. It returns only `{id,label}`. It must not expose Membership, linked global User identity, role, email or other Person metadata.

## Ordinary record relations

`record` and `record_list` are supported in Kernel 0.29.0. The source relation declares the target Model; Core resolves target records only in the same Space and only while the caller has current read authority to both the source Model projection and the target Model.

The target Model owns the canonical label through Model Definition `referenceLabel`:

- `{ field: "name" }` projects one declared scalar field;
- `{ template: "{code} · {name}" }` projects a bounded simple template;
- omitted `referenceLabel`, or an empty projection because all referenced values are null/blank, falls back to the stable `rec_*` record ID.

Lookup search/pagination and Batch Reference Resolution use the same canonical label. Core and adapters MUST NOT infer or override labels from conventional field names such as `title`, `name` or `summary`.

## Discovery projection

Relation metadata keeps selection and held-ID hydration distinct:

```json
{
  "targetModel": "person",
  "cardinality": "one",
  "lookup": {
    "supported": true,
    "method": "GET",
    "pathTemplate": "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}",
    "searchParameter": "q",
    "cursorParameter": "cursor",
    "limitParameter": "limit"
  },
  "resolution": {
    "supported": true,
    "method": "POST",
    "pathTemplate": "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
    "maxIds": 50
  }
}
```

For `record` / `record_list`, lookup and resolution are supported and use the target Model's canonical `referenceLabel` semantic or stable record-ID fallback. The descriptors remain discoverable semantic/context information, not authorization proof; each request independently rechecks current source authority and current target-model read authority.

The progressive Static Semantic Detail may expose the authority-independent `resolution` descriptor because it is stable for the model/field semantic identity, but it MUST NOT carry dynamic Relation Target Lookup results, current Membership/Grant/Delegation state or any effective authorization lease.

## Mutation independence

A successful resolved item is never an authority lease, selector token or durable proof that a later relation assignment is permitted. Create/update/action execution continues to re-check current authority, Policy and relation integrity independently.

## Cost boundary

For Person v1 the target-resolution work must remain bounded O(1) in Worker→D1 network shape for any 1–50 IDs:

1. bounded current source authority/Policy evaluation;
2. one set-based active Space Person target read;
3. in-memory mapping back to input positions.

No per-ID Worker→D1 or HTTP waterfall, positive authority cache, KV, Durable Object, TTL or push invalidation belongs in this representation.

Verified in the full repository Check on 2026-09-07 after excluding the one-time Runtime Model snapshot warm-up:

| Input | Worker→D1 round trips | max bindings | response bytes |
|---|---:|---:|---:|
| 1 ID | 2 | 4 | 127 |
| 9 positions (8 resolvable + 1 unavailable) | 2 | 10 | 962 |
| 50 IDs | 2 | 51 | 5,410 |

This evidence proves the hot request shape is independent of input cardinality within the v1 bound and that the 50-ID case remains below the repository's 100-binding budget. Wall-clock values from local Cloudflare Vitest D1 are intentionally not treated as APAC acceptance latency.
