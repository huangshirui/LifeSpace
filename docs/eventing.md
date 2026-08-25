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

A v1 subscription has two distinct ownership dimensions:

- the **managing application context** that created/configures the subscription;
- one **subscriber Service Principal** representing the external system that receives the notification.

The subscription targets exactly one Space and one model. The authenticated managing user must have the `spaces:manage` credential scope, current Space `manage` permission and current read access to the selected model.

The subscriber Service Principal must separately have a current Data Grant from that Space that permits `read`, `write` or `manage` access to the selected model (or a current whole-Space Grant at that level). Core verifies this when a subscription is created, enabled, materially edited or test-sent.

This binding is deliberate: a Webhook is one integration capability of a concrete external system, not an application-global callback with an informal UI-only association.

Delivery re-checks both current managing Application × Model Access and the subscriber Service Principal's current Data Grant. Disabling/deleting the subscription, revoking the subscriber Grant, letting that Grant expire, or revoking the managing application's model access prevents queued deliveries from being sent.

The subscriber Service Principal itself remains Identity-owned. Eventing stores only its stable principal ID as a platform reference; it does not duplicate service credentials or Identity state in Core.

Application UIs may present domain-friendly names (for example HomeMew shows `event` as `日程`) but submit stable model keys and the actual subscriber Service Principal ID to Core.

## Delivery

The D1 outbox is scanned by the Core scheduled handler and matched against active subscriptions whose subscriber still has a current Data Grant. Matching produces one durable delivery row per `(event, subscription)` and enqueues the delivery to the environment-specific Cloudflare Queue.

Delivery semantics are at-least-once. Receivers should use `X-LifeSpace-Event-Id` and/or `X-LifeSpace-Delivery-Id` for idempotency.

Webhook requests are POST JSON and include:

- `X-LifeSpace-Event-Id`
- `X-LifeSpace-Delivery-Id`
- `X-LifeSpace-Subscription-Id`
- `X-LifeSpace-Timestamp`
- `X-LifeSpace-Signature: v1=<hex HMAC-SHA256>`

The signature input is `timestamp + "." + rawBody` using the subscription signing secret. The secret is returned when a subscription is created and when explicitly rotated; normal reads never return it.

Non-2xx responses and transport failures are retried by Cloudflare Queues. After configured retries the message moves to the environment-specific dead-letter queue. Delivery logs retain status, attempt count, last HTTP status/error and timestamps; response bodies are not persisted.

## Application boundary

LifeSpace owns event creation, outbox, subscriber binding, subscription state, matching, signing, queueing, retry state and delivery logs.

Application Web/BFF layers own the user-facing configuration flow. HomeMew Web is the first consumer and initially exposes subscriptions for the `event` model (日程) inside a specific external-system detail page. HomeMew does not persist duplicate webhook/subscription state and never sends a LifeSpace service token or application credential to browser JavaScript.
