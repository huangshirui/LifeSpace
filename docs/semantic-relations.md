# Semantic Relations / 语义关系

Status: implementation in PR #339; not a production capability.

Semantic Relation is durable Shared World linkage (A1/A2), governed by current
Authority and Change (A3/A4). Predicate/model declarations are Semantics; runtime
query/hydration is Context Projection. It is a generic junction table, not a graph
engine or a new ordinary field type. Fixed references still use record/record_list.

## Contract

An edge has id, spaceId, source, predicate, target and createdAt. Each endpoint is
`{kind: "record", modelKey, recordId}` in the same Space. Predicates are registered
platform definitions with meaning and endpoint constraints. A source Model declares
`semanticRelations.outgoing`; applications cannot invent predicates. Edges are
directed, including relates_to; reverse browsing filters target. The endpoint tuple
is unique. Retrying creation rechecks current Authority and creates no duplicate Change.

Create/delete require source write + target read, including Model Policy,
Application exposure and current Delegation. Reads require both endpoints readable
and live. Relation lifecycle is independent; deleting an edge never deletes records.
Native endpoint soft deletion atomically cleans incoming/outgoing edges with Change
evidence. Insert-time endpoint guards prevent deletion/creation interleaving from
reintroducing an edge. Unsupported or missing endpoints fail opaquely.

## Query

Query source, target, predicate or their combinations, limit 1..100, with optional
hydrate=source|target|both. Current eligible endpoint models/known-record selectors
and identity-only read Policy are resolved set-wise before SQL pagination; the
visibility predicate and live endpoints participate before LIMIT. A cursor is only
issued from a returned visible edge. There is no hidden-edge scan cursor or repeated
HTTP/D1 refill loop. Hydration uses grouped typed reads. Current Policy DSL does not
support record-aware read Policy; enabling it later must first extend the query planner.

## Batch and atomicity / 批量与原子性

The unified `/api/v1/spaces/{spaceId}/models/batch` supports ordinary record operations
and relation_create/relation_delete. `atomicConsistency=true` is the compatible
default for the existing Batch API; false selects independent item outcomes. Existing
`models/bulk` record transport remains compatible. New record operations may declare
`clientRef`; relation endpoints may use `{kind:"record", modelKey, clientRef}` to
refer to a create in this request. The server assigns IDs; no arbitrary record ID is
accepted for create. A relation depends on successful creation of all referenced
records. Non-atomic dependent failure must not create a dangling edge.
Existing relation endpoints cannot also be updated/deleted in the same request;
use separate requests for that V1 shape. If no operation can be resolved for
authorization, the request is rejected before persisting batch metadata.

Native records/relations on one D1 support atomic commit. Capability support is a
precondition, not a transaction invented by Core. External endpoint resolution is
not enabled by this PR; #340 owns provider-neutral resolution and capability discovery.
External Provider operations mixed with D1 are never a distributed transaction,
even if the Provider supports its own transactions. Unsupported atomic requests
must fail explicitly, never silently downgrade. Notion atomicBatch=false.

Relation changes preserve Principal, Actor, Application and Delegation independently
from information provenance. Single-use consumption remains atomic with its item;
one grant cannot authorize two successful actions. An attached relation is part of
the source-create action, while an independent relation operation is its own action.

## Performance and release gates

Hot registry resolution uses isolate metadata. Authority is de-duplicated; endpoint
state is read by model in bounded D1 batches. Ordinary paths do not hydrate semantic
relations. Test Native create/query/get/delete, 20-item mixed batches, 1000+ edges,
sparse visibility, query plans/rows read, concurrency and all credential profiles.
Local test duration is not a Provider or deployed latency SLA. Staging and controlled
JWT/Service/Agent wall-time measurements precede a production capability claim.
