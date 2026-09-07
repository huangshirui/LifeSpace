# Generic Consumer Reference Resolution v1

Status: **Candidate / Public representation**  
Kernel contract: **0.28.0**  
Semantic owner: `docs/generic-consumer-m2-dynamic-authority-audit.md` §4–5, §10–12  
Owning implementation: #191 under #165  
Ordinary-record label dependency: #155

This document fixes the first HTTP representation for the already-accepted M2 Batch Reference Resolution / Hydration semantic. It does not redefine Relation Target Lookup, Model Definition semantics, reference-label semantics or mutation authority.

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
- each item is a non-empty string valid for the source relation kind (`^per_` for Person v1);
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

`record` and `record_list` resolution remain field-level unsupported until #155 defines canonical ordinary-record reference-label semantics.

The stable reason is:

```text
reference-label-unavailable
```

Core and adapters MUST NOT infer a record label from conventional fields such as `title`, `name` or `summary`.

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

For `record` / `record_list`, `resolution.supported=false` with `reason=reference-label-unavailable` until #155. This projection is discoverable semantic/context information, not authorization proof.

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
