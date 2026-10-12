# LifeSpace Eventing

LifeSpace Eventing is the platform-owned mechanism for publishing ordinary-model changes to authorized external subscribers. Applications own product-facing configuration UX; they do not create parallel event, webhook, delivery, or retry stores.

Canonical public contract: `apps/core/integration-eventing.openapi.yaml` (Integration/Eventing `0.4.0`). It is independently versioned and compatibility-checked from the Core Kernel contract while remaining implemented in the same Core Worker.

## External origin boundary / 外部来源边界

Authoritative mutation + D1 outbox guarantees in this document apply only to LifeSpace-owned Native storage. External provider writes and provider-direct edits do not generate Native record.* events in V1. External operation audit is independent non-atomic execution evidence, not a surrogate outbox. Any later external Eventing capability must separately define delivery, crash-window and idempotency semantics.

## Event model

All ordinary models emit model-agnostic event types:

- `record.created`
- `record.updated`
- `record.deleted`

`modelKey` identifies the model. LifeSpace does not add model-specific event names such as `calendar.updated`.

The authoritative mutation and the event outbox entry are atomic. D1 triggers on `resource_records` write the outbox inside the same transaction/batch as the ordinary-model mutation. Capability-specific mutation paths therefore participate without handwritten event hooks.

External Webhook payloads are reference-only and contain event ID/type, Space, model key, record ID/version and occurrence time. They do not contain the full record or actor identity. A receiving system that needs record data must authenticate normally and pass current LifeSpace credential scope, Application × Model Access and Space/Data Grant authorization.

## Endpoint and subscription model

Eventing separates **transport/signing** from **event filtering**.

### Webhook Endpoint

A Webhook Endpoint represents one reusable callback destination for one external system in one Space:

```text
Webhook Endpoint
  applicationId
  spaceId
  subscriberServicePrincipalId
  name
  webhookUrl
  signingSecret
  enabled
```

It answers:

> Where are events sent, and how does the receiver verify that they came from LifeSpace?

The signing secret belongs to the endpoint, not to an individual model subscription. It is returned only when the endpoint is created or explicitly rotated; normal reads never return plaintext or hashes.

An endpoint may have multiple event subscriptions. This allows one external system to configure one URL and one signing secret, then select multiple models without duplicating transport configuration.

### Event Subscription

An Event Subscription is a filter attached to one Webhook Endpoint:

```text
Event Subscription
  endpointId
  modelKey
  eventTypes[]
  enabled
```

It answers:

> Which changes should be delivered through this endpoint?

A subscription targets exactly one published model. One endpoint may therefore subscribe to `event`, `task`, `day_record`, or future models independently while reusing the same callback and signing configuration.

The current implementation allows at most one active subscription per `(endpointId, modelKey)`; event-type selection is edited on that filter rather than by creating duplicate subscriptions for the same model.

## Ownership and authorization

A Webhook Endpoint has two ownership dimensions:

- the **managing application context** that created/configures it;
- one **subscriber Service Principal** representing the external system that receives notifications.

The endpoint is scoped to one Space. Creating/updating/testing an endpoint is a user/Space-management operation: it requires `spaces:manage` and current Space `manage` permission. Creating an endpoint by itself grants no model data access.

A subscription adds a model filter to that endpoint. Creating, enabling or materially editing a subscription additionally requires:

- current read access to the selected model for the managing application/user context;
- a current Data Grant that lets the endpoint's subscriber Service Principal read, write or manage that model in the endpoint Space, or an equivalent whole-Space Grant.

Delivery re-checks current managing Application × Model Access, the subscriber Service Principal's current Data Grant and the subscriber's current Identity eligibility before the outbound Webhook request begins. Disabling/deleting the endpoint or subscription, revoking/expiring the subscriber Grant, revoking the managing application's model access, disabling the subscriber Service Principal or disabling its owning registered application therefore prevents a queued delivery from crossing the outbound boundary.

The subscriber Service Principal itself remains Identity-owned. Eventing stores only its stable principal ID as a platform reference; it does not duplicate service credentials or Identity state in Core. The final Queue consumer asks Identity over the authenticated Core -> Identity Service Binding for the current principal/application eligibility immediately before delivery. This current-state check is the security boundary for passive Eventing delivery; application-side Grant cleanup is useful hygiene but is not the kill switch.

Re-enabling a Service Principal restores only Identity eligibility. It does not recreate a revoked/expired Data Grant, a disabled/deleted Endpoint or Subscription, or removed Application × Model Access. All of those independent current-state checks must still pass.

Application UIs may present domain-friendly names, but they submit stable model keys and the actual subscriber Service Principal ID to Core.

## Delivery

The D1 outbox is scanned by the Core scheduled handler and matched against active subscription filters whose endpoint is active and whose subscriber still has a current Data Grant. Matching produces one durable delivery row per `(event, subscription)` and enqueues the delivery to the environment-specific Cloudflare Queue.

Outbox matching intentionally does not copy or cache Identity principal state. The Queue consumer is the final authority gate: after re-checking the Core-owned endpoint/subscription, Application × Model Access and Data Grant state, it queries Identity current state by stable `svc_*` ID before any outbound HTTP attempt or delivery-attempt increment.

The resulting behavior is fail-closed:

- active Service Principal + active owning application + all Core authority still current -> delivery may proceed;
- disabled/missing Service Principal or disabled owning application -> mark the delivery `cancelled`, acknowledge the Queue message and send no Webhook;
- Identity current state cannot be confirmed because the Service Binding is unavailable, returns non-success, or returns an invalid response -> send no Webhook, mark the delivery `failed` and retry the Queue message;
- a prolonged Identity outage may eventually exhaust the configured Queue retries and move the message to the environment-specific dead-letter queue, but it must never degrade into delivery based on stale positive Identity state.

This design deliberately accepts one authenticated Service Binding + Identity current-state read for each delivery that survives the Core-owned authority checks. Positive caching or replicated principal eligibility is not part of the correctness boundary unless a future design supplies explicit revocation-safe freshness semantics.

Delivery semantics are at-least-once. For an ordinary independent Change, receivers should use `X-LifeSpace-Event-Id` and/or `X-LifeSpace-Delivery-Id` for idempotency.

An explicit first-class Runtime Batch is delivered differently at the transport envelope only. Every committed resource mutation still owns one governed Change, one Domain Event reference and one durable per-subscription delivery row. Events that share the same explicit `changeSetId` are grouped by Webhook Endpoint and sent as one signed `change_set.committed` callback containing `1..20` reference-only `events[]`. The batch callback uses `X-LifeSpace-Change-Set-Id` plus `X-LifeSpace-Delivery-Id` as its idempotency identity. This aggregation applies only to the explicit atomic ChangeSet; unrelated operations are never merged by a time window.

Batch delivery re-runs the same send-time endpoint/subscription, Application × Model Access, subscriber Data Grant and Service Principal eligibility checks before the outbound request. Aggregation therefore changes transport fan-out, not authority or individual Change/Event evidence.

An explicit non-atomic Bulk uses the same transport aggregation rule without pretending to be a ChangeSet. Successful events sharing one `bulkId` are grouped by Webhook Endpoint and sent as one signed `bulk.completed` callback containing `1..20` reference-only `events[]`; failed Bulk items produce no committed Change/Event and are absent from that envelope. The callback uses `X-LifeSpace-Bulk-Id` plus `X-LifeSpace-Delivery-Id` as its idempotency identity. Unrelated operations are never time-window coalesced.

ChangeSet dispatch is also a structural performance boundary: subscription eligibility for all 1..20 events is resolved set-wise, delivery rows are materialized/read through bounded D1 I/O, and queued-state updates are batched after endpoint grouping. D1 round trips therefore remain bounded in ChangeSet item count; outbound Queue sends may scale with the number of distinct eligible endpoints, not with duplicate per-event database loops.

Webhook requests are POST JSON and include:

- `X-LifeSpace-Event-Id`
- `X-LifeSpace-Delivery-Id`
- `X-LifeSpace-Webhook-Endpoint-Id`
- `X-LifeSpace-Subscription-Id`
- `X-LifeSpace-Timestamp`
- `X-LifeSpace-Signature: v1=<hex HMAC-SHA256>`

The signature input is `timestamp + "." + rawBody` using the endpoint signing secret.

Webhook transport is deliberately **public HTTPS egress**, including when a valid callback happens to use a Cloudflare Custom Domain in the same DNS zone as Core. Core therefore configures the Workers global `fetch()` runtime with `global_fetch_strictly_public`, so a same-zone callback traverses Cloudflare's public front door instead of being resolved as a private origin lookup. Trusted same-account internal calls such as Core -> Identity continue to use explicit Service Bindings; Eventing must not silently replace a configured public Webhook URL with a Service Binding because that would test and execute a different transport contract.

Non-2xx responses and transport failures are retried by Cloudflare Queues. After configured retries the message moves to the environment-specific dead-letter queue. Delivery logs retain status, attempt count, last HTTP status/error and timestamps; response bodies are not persisted.

Delivery diagnostics are endpoint-level so an operator can see all model notifications using the shared destination in one history view. Each delivery still exposes its source `modelKey` and subscription ID for diagnosis.

## Test send

A Webhook Endpoint can send a signed `endpoint.test` payload without reading any ordinary model record. Test send proves transport and signature verification only; it does not prove that every selected model currently has a valid Data Grant. It is intentionally not the normal domain-event delivery authority path and therefore does not substitute for the send-time subscriber eligibility check described above.

## Application boundary

LifeSpace owns event creation, outbox state, endpoint transport/signing, subscriber binding, subscription filters, matching, queueing, retry state and delivery logs.

Application Web/BFF layers own the user-facing configuration flow. A normal product UI should generally present one callback configuration for an external system and then allow the user to select the models/events delivered through it. The platform does not force applications to expose one Webhook URL or signing secret per model.
