# LifeSpace Eventing

LifeSpace Eventing is the platform-owned mechanism for publishing ordinary-model changes to authorized external subscribers. Applications own product-facing configuration UX; they do not create parallel event, webhook, delivery, or retry stores.

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

Delivery re-checks both current managing Application × Model Access and the subscriber Service Principal's current Data Grant. Disabling/deleting the endpoint or subscription, revoking/expiring the subscriber Grant, or revoking the managing application's model access prevents queued deliveries from being sent.

The subscriber Service Principal itself remains Identity-owned. Eventing stores only its stable principal ID as a platform reference; it does not duplicate service credentials or Identity state in Core.

Application UIs may present domain-friendly names (for example HomeMew shows `event` as `日程`) but submit stable model keys and the actual subscriber Service Principal ID to Core.

## Delivery

The D1 outbox is scanned by the Core scheduled handler and matched against active subscription filters whose endpoint is active and whose subscriber still has a current Data Grant. Matching produces one durable delivery row per `(event, subscription)` and enqueues the delivery to the environment-specific Cloudflare Queue.

Delivery semantics are at-least-once. Receivers should use `X-LifeSpace-Event-Id` and/or `X-LifeSpace-Delivery-Id` for idempotency.

Webhook requests are POST JSON and include:

- `X-LifeSpace-Event-Id`
- `X-LifeSpace-Delivery-Id`
- `X-LifeSpace-Webhook-Endpoint-Id`
- `X-LifeSpace-Subscription-Id`
- `X-LifeSpace-Timestamp`
- `X-LifeSpace-Signature: v1=<hex HMAC-SHA256>`

The signature input is `timestamp + "." + rawBody` using the endpoint signing secret.

Non-2xx responses and transport failures are retried by Cloudflare Queues. After configured retries the message moves to the environment-specific dead-letter queue. Delivery logs retain status, attempt count, last HTTP status/error and timestamps; response bodies are not persisted.

Delivery diagnostics are endpoint-level so an operator can see all model notifications using the shared destination in one history view. Each delivery still exposes its source `modelKey` and subscription ID for diagnosis.

## Test send

A Webhook Endpoint can send a signed `endpoint.test` payload without reading any ordinary model record. Test send proves transport and signature verification only; it does not prove that every selected model currently has a valid Data Grant.

## Application boundary

LifeSpace owns event creation, outbox state, endpoint transport/signing, subscriber binding, subscription filters, matching, queueing, retry state and delivery logs.

Application Web/BFF layers own the user-facing configuration flow. A normal product UI should generally present one callback configuration for an external system and then allow the user to select the models/events delivered through it. The platform does not force applications to expose one Webhook URL or signing secret per model.
