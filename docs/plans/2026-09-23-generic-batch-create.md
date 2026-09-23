# Generic Batch Create v1

Status: **Implemented on `feat/generic-batch-create`; pending review/merge**  
Date: **2026-09-23**  
Tracking: **#276**

## Problem

Agent and automation clients frequently turn one user intent into several ordinary records. Examples include creating multiple Events from a schedule, multiple Tasks from a checklist, or an Event plus its follow-up Tasks. Repeating the single-record Create API multiplies HTTP/authentication/current-authority/D1 round trips and exposes partially completed intent when a later call fails.

The capability belongs to LifeSpace Core rather than an n8n, MCP, ALOHA or model-specific adapter because the durable concern is committing a bounded set of authorized ordinary-model Creates into one Space.

## Contract

```http
POST /api/v1/spaces/{spaceId}/records/batch
```

Request:

```json
{
  "items": [
    {
      "clientRef": "event-1",
      "modelKey": "event",
      "input": {}
    },
    {
      "clientRef": "task-1",
      "modelKey": "task",
      "input": {}
    }
  ]
}
```

Rules:

- one Space per request;
- 1–20 items;
- models may differ within the batch;
- `clientRef` is optional, bounded, unique within the request and echoed only for correlation;
- `input` has exactly the same semantic meaning as the selected model's ordinary single Create body, including optional Information Provenance;
- ordinary model schema remains owned by the immutable `mct_*` Model Contract; Kernel does not duplicate concrete Event/Task/etc. schemas.

Response is intentionally minimal: `clientRef?`, `modelKey`, `id`, `version`, `createdAt`.

## Execution semantics

Batch Create is **atomic all-or-nothing**.

For every distinct model, Core resolves the current Runtime Model Descriptor and rechecks current write authority. For every item, Core preserves the existing create path:

```text
Model defaults/schema
-> Capability preparation
-> Model Policy
-> relation projection/integrity
-> Information Provenance
-> typed model storage
-> resource envelope
-> governed Change evidence
-> Domain Event outbox
```

The implementation is factored as:

```text
prepare all items
-> aggregate relation target validation
-> one D1 batch/transaction commit
```

Single-record Create reuses the same prepare/commit primitives so Batch Create is not a second mutation implementation.

Agent Delegation remains model-specific/current-state authority. A mixed-model Agent batch succeeds only when the current Delegation and every other authority term allow every selected model.

## Eventing / callback semantics

Batch atomicity and callback grouping are related but distinct:

```text
single ordinary operation
  -> 1 Domain Event
  -> 1 callback

explicit Batch Create with N created records
  -> N Domain Events
  -> same ordered opg_* operation group
  -> 1 callback per matching Webhook Endpoint
  -> callback body { "operationGroupId": "opg_*", "events": [ ...matching event references... ] }

N independent operations close together in time
  -> N independent Domain Events
  -> no operation group
  -> N independent callbacks
```

LifeSpace Core deliberately does **not** implement a debounce/time-window merger. Grouping is based only on explicit durable operation provenance written in the same atomic commit. An endpoint that subscribes to only a subset of models receives one callback containing only the currently authorized matching events from that operation.

Integration/Eventing advances to `0.3.0` for this callback representation. Existing independent single-event delivery remains wire-compatible.

## Performance invariant

The optimization target is Worker↔D1 round trips rather than statement count.

With hot Runtime model descriptors:

- 20 same-model Tasks with Person relations: at most **3 Core D1 round trips** (model authority, aggregate relation validation, commit), independent of item count;
- a two-model Event+Task batch with Person relations: at most **4 Core D1 round trips** (one authority check per distinct model, aggregate relation validation, commit);
- an opaque `lsp_pat_*` caller also pays Core→Identity introspection once for the whole HTTP request instead of once per record.

The item limit of 20 bounds transaction size and response/request work.

## Explicit v1 exclusions

- cross-Space batch;
- update/delete/action in the same batch;
- dependencies on records created earlier in the same batch;
- generic uncertain-write/idempotency semantics.

Generic idempotency is a separate platform contract problem and should not be smuggled into this feature without defining replay lifetime, authority binding and retained result semantics.

## Consumers

n8n Agent Tool, MCP, ALOHA and other adapters should project this capability rather than implement their own loops or partial-success logic. Protocol adapters remain replaceable; Core owns the atomic governed Change semantics.
