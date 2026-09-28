import type { Bindings } from "./env";
import { ApiError } from "./http";
import { servicePrincipalIsActive } from "./service-principal-authority";

export type DomainEventType = "record.created" | "record.updated" | "record.deleted";
export type WebhookDeliveryQueueMessage =
  | { kind: "webhook-delivery"; deliveryId: string }
  | {
      kind: "webhook-delivery-batch";
      deliveryIds: string[];
      changeSetId: string;
      endpointId: string;
      batchDeliveryId: string;
    };

type OutboxRow = {
  id: string;
  event_type: DomainEventType;
  space_id: string;
  model_key: string;
  record_id: string;
  record_version: number;
  change_id: string | null;
  change_set_id: string | null;
  occurred_at: string;
};

type DeliveryRow = {
  id: string;
  event_id: string;
  subscription_id: string;
  status: "pending" | "queued" | "succeeded" | "failed" | "cancelled";
  endpoint_id: string | null;
  webhook_url: string | null;
  signing_secret: string | null;
  endpoint_enabled: number | null;
  subscription_enabled: number | null;
  application_id: string | null;
  subscriber_service_principal_id: string | null;
  model_key: string | null;
};

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

export function createWebhookSigningSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_WEBHOOK_URL", "webhookUrl is required", 400);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError("INVALID_WEBHOOK_URL", "webhookUrl must be a valid HTTPS URL", 400);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) throw new ApiError("INVALID_WEBHOOK_URL", "webhookUrl must be an HTTPS URL without embedded credentials", 400);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.includes(":") || isPrivateIpv4(hostname)) {
    throw new ApiError("INVALID_WEBHOOK_URL", "webhookUrl must target a public HTTPS host", 400);
  }
  return url.toString();
}

function eventPayload(event: OutboxRow) {
  return {
    id: event.id,
    type: event.event_type,
    spaceId: event.space_id,
    modelKey: event.model_key,
    recordId: event.record_id,
    recordVersion: event.record_version,
    changeId: event.change_id,
    occurredAt: event.occurred_at,
  };
}

async function signature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedFetch(url: string, secret: string, body: string, headers: Record<string, string>): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = await signature(secret, timestamp, body);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lifespace-timestamp": timestamp,
      "x-lifespace-signature": `v1=${digest}`,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
}

type EligibleSubscription = { id: string; endpoint_id: string };

async function eligibleSubscriptions(env: Bindings, event: OutboxRow): Promise<EligibleSubscription[]> {
  const currentTime = now();
  const subscriptions = await env.DB.prepare(`SELECT s.id,e.id endpoint_id
    FROM event_subscriptions s
    JOIN webhook_endpoints e ON e.id=s.endpoint_id
    JOIN application_model_access ama
      ON ama.application_id=e.application_id AND ama.model_key=s.model_key
    WHERE s.deleted_at IS NULL AND s.enabled=1
      AND e.deleted_at IS NULL AND e.enabled=1
      AND e.space_id=? AND s.model_key=?
      AND (
        (?='record.created' AND s.include_created=1)
        OR (?='record.updated' AND s.include_updated=1)
        OR (?='record.deleted' AND s.include_deleted=1)
      )
      AND EXISTS (
        SELECT 1 FROM data_grants g
        WHERE g.source_space_id=e.space_id
          AND g.grantee_type='service'
          AND g.grantee_id=e.subscriber_service_principal_id
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>?)
          AND g.permission IN ('read','write','manage')
          AND (
            (g.resource_type='model' AND g.resource_id=s.model_key)
            OR (g.resource_type='space' AND g.resource_id IS NULL)
          )
      )`)
    .bind(
      event.space_id,
      event.model_key,
      event.event_type,
      event.event_type,
      event.event_type,
      currentTime,
    )
    .all<EligibleSubscription>();
  return subscriptions.results;
}

async function ensureDelivery(
  env: Bindings,
  event: OutboxRow,
  subscriptionId: string,
): Promise<{ id: string; status: string }> {
  const deliveryId = id("dlv");
  const timestamp = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries(
    id,event_id,subscription_id,status,created_at,updated_at
  ) VALUES(?,?,?,'pending',?,?)`)
    .bind(deliveryId, event.id, subscriptionId, timestamp, timestamp)
    .run();
  const delivery = await env.DB.prepare(
    "SELECT id,status FROM webhook_deliveries WHERE event_id=? AND subscription_id=?",
  ).bind(event.id, subscriptionId).first<{ id: string; status: string }>();
  if (!delivery) throw new Error("Webhook delivery row could not be created");
  return delivery;
}

async function markEventsDispatched(env: Bindings, events: readonly OutboxRow[]): Promise<void> {
  const timestamp = now();
  await env.DB.batch(events.map((event) => env.DB.prepare(`UPDATE domain_event_outbox
    SET dispatched_at=?,dispatch_attempt_count=dispatch_attempt_count+1,
        last_dispatch_attempt_at=?,last_dispatch_error=NULL
    WHERE id=? AND dispatched_at IS NULL`)
    .bind(timestamp, timestamp, event.id)));
}

async function dispatchEvent(env: Bindings, event: OutboxRow): Promise<void> {
  const subscriptions = await eligibleSubscriptions(env, event);
  for (const subscription of subscriptions) {
    const delivery = await ensureDelivery(env, event, subscription.id);
    if (delivery.status === "queued" || delivery.status === "succeeded" || delivery.status === "cancelled") continue;

    await env.EVENT_DELIVERY_QUEUE.send({
      kind: "webhook-delivery",
      deliveryId: delivery.id,
    } satisfies WebhookDeliveryQueueMessage);
    const timestamp = now();
    await env.DB.prepare(`UPDATE webhook_deliveries
      SET status='queued',queued_at=?,updated_at=?,last_error=NULL
      WHERE id=? AND status IN ('pending','failed')`)
      .bind(timestamp, timestamp, delivery.id)
      .run();
  }
  await markEventsDispatched(env, [event]);
}

function deterministicBatchDeliveryId(changeSetId: string, endpointId: string): string {
  const change = changeSetId.startsWith("cgs_") ? changeSetId.slice(4) : changeSetId;
  const endpoint = endpointId.startsWith("whk_") ? endpointId.slice(4) : endpointId;
  return `bdl_${change}_${endpoint}`;
}

async function dispatchChangeSet(env: Bindings, events: readonly OutboxRow[]): Promise<void> {
  if (!events.length) return;
  const changeSetId = events[0]!.change_set_id;
  if (!changeSetId || events.some((event) => event.change_set_id !== changeSetId)) {
    throw new Error("Batch Eventing requires one coherent ChangeSet");
  }

  const deliveriesByEndpoint = new Map<string, string[]>();
  for (const event of events) {
    const subscriptions = await eligibleSubscriptions(env, event);
    for (const subscription of subscriptions) {
      const delivery = await ensureDelivery(env, event, subscription.id);
      if (delivery.status === "queued" || delivery.status === "succeeded" || delivery.status === "cancelled") continue;
      const ids = deliveriesByEndpoint.get(subscription.endpoint_id) ?? [];
      ids.push(delivery.id);
      deliveriesByEndpoint.set(subscription.endpoint_id, ids);
    }
  }

  for (const [endpointId, deliveryIds] of deliveriesByEndpoint) {
    if (!deliveryIds.length) continue;
    const batchDeliveryId = deterministicBatchDeliveryId(changeSetId, endpointId);
    await env.EVENT_DELIVERY_QUEUE.send({
      kind: "webhook-delivery-batch",
      deliveryIds,
      changeSetId,
      endpointId,
      batchDeliveryId,
    } satisfies WebhookDeliveryQueueMessage);
    const timestamp = now();
    const placeholders = deliveryIds.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE webhook_deliveries
      SET status='queued',queued_at=?,updated_at=?,last_error=NULL
      WHERE id IN (${placeholders}) AND status IN ('pending','failed')`)
      .bind(timestamp, timestamp, ...deliveryIds)
      .run();
  }

  await markEventsDispatched(env, events);
}

function outboxSelect(): string {
  return `SELECT id,event_type,space_id,model_key,record_id,record_version,
      change_id,change_set_id,occurred_at
    FROM domain_event_outbox`;
}

async function expandSelectedChangeSets(
  env: Bindings,
  selected: readonly OutboxRow[],
): Promise<OutboxRow[]> {
  const changeSetIds = [...new Set(
    selected.map((event) => event.change_set_id).filter((value): value is string => Boolean(value)),
  )];
  if (!changeSetIds.length) return [...selected];
  const placeholders = changeSetIds.map(() => "?").join(",");
  const related = await env.DB.prepare(`${outboxSelect()}
    WHERE dispatched_at IS NULL AND change_set_id IN (${placeholders})
    ORDER BY occurred_at,id`)
    .bind(...changeSetIds)
    .all<OutboxRow>();
  const byId = new Map(selected.map((event) => [event.id, event]));
  for (const event of related.results) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) =>
    left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id)
  );
}

async function markDispatchFailure(
  env: Bindings,
  events: readonly OutboxRow[],
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 300) : "dispatch failed";
  const timestamp = now();
  await env.DB.batch(events.map((event) => env.DB.prepare(`UPDATE domain_event_outbox
    SET dispatch_attempt_count=dispatch_attempt_count+1,last_dispatch_attempt_at=?,last_dispatch_error=?
    WHERE id=? AND dispatched_at IS NULL`)
    .bind(timestamp, message, event.id)));
  console.error("Domain event dispatch failed", {
    eventIds: events.map((event) => event.id),
    changeSetId: events[0]?.change_set_id ?? null,
    error: message,
  });
}

export async function dispatchPendingDomainEvents(env: Bindings, limit = 50): Promise<number> {
  const selected = await env.DB.prepare(`${outboxSelect()}
    WHERE dispatched_at IS NULL ORDER BY occurred_at,id LIMIT ?`)
    .bind(limit)
    .all<OutboxRow>();
  const rows = await expandSelectedChangeSets(env, selected.results);

  const singles: OutboxRow[] = [];
  const groups = new Map<string, OutboxRow[]>();
  for (const event of rows) {
    if (!event.change_set_id) {
      singles.push(event);
      continue;
    }
    const group = groups.get(event.change_set_id) ?? [];
    group.push(event);
    groups.set(event.change_set_id, group);
  }

  let dispatched = 0;
  for (const event of singles) {
    try {
      await dispatchEvent(env, event);
      dispatched += 1;
    } catch (error) {
      await markDispatchFailure(env, [event], error);
    }
  }
  for (const events of groups.values()) {
    try {
      await dispatchChangeSet(env, events);
      dispatched += events.length;
    } catch (error) {
      await markDispatchFailure(env, events, error);
    }
  }
  return dispatched;
}

async function loadDelivery(env: Bindings, deliveryId: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(`SELECT d.id,d.event_id,d.subscription_id,d.status,
      s.endpoint_id,s.enabled AS subscription_enabled,s.model_key,
      e.webhook_url,e.signing_secret,e.enabled AS endpoint_enabled,e.application_id,e.subscriber_service_principal_id
    FROM webhook_deliveries d
    LEFT JOIN event_subscriptions s ON s.id=d.subscription_id AND s.deleted_at IS NULL
    LEFT JOIN webhook_endpoints e ON e.id=s.endpoint_id AND e.deleted_at IS NULL
    WHERE d.id=?`)
    .bind(deliveryId).first<DeliveryRow>();
}

async function applicationCanReceive(env: Bindings, applicationId: string, modelKey: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS allowed FROM application_model_access
    WHERE application_id=? AND model_key=? LIMIT 1`)
    .bind(applicationId, modelKey).first<{ allowed: number }>();
  return Boolean(row);
}

async function subscriberCanReceive(env: Bindings, subscriberId: string, spaceId: string, modelKey: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS allowed FROM data_grants
    WHERE source_space_id=?
      AND grantee_type='service'
      AND grantee_id=?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?)
      AND permission IN ('read','write','manage')
      AND (
        (resource_type='model' AND resource_id=?)
        OR (resource_type='space' AND resource_id IS NULL)
      )
    LIMIT 1`)
    .bind(spaceId, subscriberId, now(), modelKey).first<{ allowed: number }>();
  return Boolean(row);
}

async function deliverOne(env: Bindings, deliveryId: string): Promise<"ack" | "retry"> {
  const delivery = await loadDelivery(env, deliveryId);
  if (!delivery || delivery.status === "succeeded" || delivery.status === "cancelled") return "ack";
  if (!delivery.endpoint_id || !delivery.webhook_url || !delivery.signing_secret || !delivery.endpoint_enabled || !delivery.subscription_enabled
      || !delivery.application_id || !delivery.subscriber_service_principal_id || !delivery.model_key
      || !(await applicationCanReceive(env, delivery.application_id, delivery.model_key))) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='endpoint/subscription unavailable or access revoked' WHERE id=?`)
      .bind(now(), deliveryId).run();
    return "ack";
  }
  const event = await env.DB.prepare(`SELECT id,event_type,space_id,model_key,record_id,record_version,change_id,change_set_id,occurred_at
    FROM domain_event_outbox WHERE id=?`)
    .bind(delivery.event_id).first<OutboxRow>();
  if (!event) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='event unavailable' WHERE id=?`)
      .bind(now(), deliveryId).run();
    return "ack";
  }
  if (!(await subscriberCanReceive(env, delivery.subscriber_service_principal_id, event.space_id, event.model_key))) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='subscriber grant revoked or expired' WHERE id=?`)
      .bind(now(), deliveryId).run();
    return "ack";
  }

  let subscriberActive: boolean;
  try {
    subscriberActive = await servicePrincipalIsActive(env, delivery.subscriber_service_principal_id);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "subscriber identity status unavailable";
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='failed',updated_at=?,last_error=? WHERE id=?`)
      .bind(now(), `subscriber identity status unavailable: ${message}`, deliveryId).run();
    console.error("Webhook subscriber identity check failed", { deliveryId, subscriberId: delivery.subscriber_service_principal_id, error: message });
    return "retry";
  }
  if (!subscriberActive) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='subscriber service principal inactive' WHERE id=?`)
      .bind(now(), deliveryId).run();
    return "ack";
  }

  const body = JSON.stringify(eventPayload(event));
  const attemptedAt = now();
  await env.DB.prepare(`UPDATE webhook_deliveries SET attempt_count=attempt_count+1,updated_at=? WHERE id=?`)
    .bind(attemptedAt, deliveryId).run();
  try {
    const response = await signedFetch(delivery.webhook_url, delivery.signing_secret, body, {
      "x-lifespace-event-id": event.id,
      "x-lifespace-delivery-id": delivery.id,
      "x-lifespace-webhook-endpoint-id": delivery.endpoint_id,
      "x-lifespace-subscription-id": delivery.subscription_id,
    });
    if (response.ok) {
      await env.DB.prepare(`UPDATE webhook_deliveries
        SET status='succeeded',delivered_at=?,last_status_code=?,last_error=NULL,updated_at=? WHERE id=?`)
        .bind(now(), response.status, now(), deliveryId).run();
      return "ack";
    }
    await env.DB.prepare(`UPDATE webhook_deliveries
      SET status='failed',last_status_code=?,last_error=?,updated_at=? WHERE id=?`)
      .bind(response.status, `HTTP ${response.status}`, now(), deliveryId).run();
    return "retry";
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "webhook request failed";
    await env.DB.prepare(`UPDATE webhook_deliveries
      SET status='failed',last_error=?,updated_at=? WHERE id=?`)
      .bind(message, now(), deliveryId).run();
    return "retry";
  }
}

export async function processWebhookDeliveryQueue(
  batch: MessageBatch<WebhookDeliveryQueueMessage>,
  env: Bindings,
): Promise<void> {
  for (const message of batch.messages) {
    if (!message.body || message.body.kind !== "webhook-delivery" || typeof message.body.deliveryId !== "string") {
      message.ack();
      continue;
    }
    const result = await deliverOne(env, message.body.deliveryId);
    if (result === "retry") message.retry();
    else message.ack();
  }
}

export async function sendWebhookEndpointTest(
  url: string,
  secret: string,
  endpointId: string,
  spaceId: string,
  subscriberServicePrincipalId: string,
) {
  const body = JSON.stringify({
    id: id("test"),
    type: "endpoint.test",
    endpointId,
    spaceId,
    subscriberServicePrincipalId,
    occurredAt: now(),
  });
  const response = await signedFetch(url, secret, body, {
    "x-lifespace-test": "true",
    "x-lifespace-webhook-endpoint-id": endpointId,
  });
  return { ok: response.ok, statusCode: response.status };
}
