# LifeSpace Eventing

LifeSpace Eventing is the platform-owned mechanism for publishing ordinary-model changes to authorized external subscribers. Applications own product-facing configuration UX; they do not create parallel event, webhook, delivery, or retry stores.

## Event model

All ordinary models emit model-agnostic event types:

- `record.created`
- `record.updated`
- `record.deleted`

`modelKey` identifies the model. LifeSpace does not add model-specific event names such as `calendar.updated`.

The authoritative mutation and the event outbox entry are atomic. D1 triggers on `resource_records` write the outbox inside the same transaction/batch as the ordinary-model mutation. Capability-specific mutation paths therefore participate without handwritten event hooks.

External webhook payloads are reference-only and contain event ID/type, Space, model key, record ID/version and occurrence time. They do not contain the full record or actor identity. A receiving system that needs record data must authenticate normally and pass current LifeSpace credential scope, Application × Model Access and Space/Data Grant authorization.

## Subscription ownership and authorization

A subscription is owned by the LifeSpace application context that creates it and targets exactly one Space and one model in v1. The authenticated user must have Space `manage` permission and the application/user context must have current read access to the selected model. The v1 management API additionally requires the existing `grants:manage` management scope used by application-side external-integration administration.

Delivery re-checks current Application × Model Access. Disabling/deleting the subscription or revoking model access prevents queued deliveries from being sent.

Application UIs may present domain-friendly names (for example HomeMew shows `event` as `日程`) but submit stable model keys to Core.

## Delivery

The D1 outbox is scanned by the Core scheduled handler and matched against active subscriptions. Matching produces one durable delivery row per `(event, subscription)` and enqueues the delivery to the environment-specific Cloudflare Queue.

Delivery semantics are at-least-once. Receivers should use `X-LifeSpace-Event-Id` and/or `X-LifeSpace-Delivery-Id` for idempotency.

Webhook requests are POST JSON and include:

- `X-LifeSpace-Event-Id`
- `X-LifeSpace-Delivery-Id`
- `X-LifeSpace-Timestamp`
- `X-LifeSpace-Signature: v1=<hex HMAC-SHA256>`

The signature input is `timestamp + "." + rawBody` using the subscription signing secret. The secret is returned when a subscription is created and when explicitly rotated; normal reads never return it.

Non-2xx responses and transport failures are retried by Cloudflare Queues. After configured retries the message moves to the environment-specific dead-letter queue. Delivery logs retain status, attempt count, last HTTP status/error and timestamps; response bodies are not persisted.

## Application boundary

LifeSpace owns event creation, outbox, subscription state, matching, signing, queueing, retry state and delivery logs.

Application Web/BFF layers own the user-facing configuration flow. HomeMew Web is the first consumer and initially exposes subscriptions for the `event` model (日程). HomeMew does not persist duplicate webhook/subscription state and never sends a LifeSpace service token or application credential to browser JavaScript.
