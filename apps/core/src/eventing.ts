import type { Bindings } from "./env";
import { ApiError } from "./http";

export type DomainEventType = "record.created" | "record.updated" | "record.deleted";
export type WebhookDeliveryQueueMessage = { kind: "webhook-delivery"; deliveryId: string };

type OutboxRow = {
  id: string;
  event_type: DomainEventType;
  space_id: string;
  model_key: string;
  record_id: string;
  record_version: number;
  occurred_at: string;
};

type DeliveryRow = {
  id: string;
  event_id: string;
  subscription_id: string;
  status: "pending" | "queued" | "succeeded" | "failed" | "cancelled";
  webhook_url: string | null;
  signing_secret: string | null;
  subscription_enabled: number | null;
  application_id: string | null;
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
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.includes(":" ) || isPrivateIpv4(hostname)) {
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

async function dispatchEvent(env: Bindings, event: OutboxRow): Promise<void> {
  const subscriptions = await env.DB.prepare(`SELECT s.id
    FROM event_subscriptions s
    JOIN application_model_access ama
      ON ama.application_id=s.application_id AND ama.model_key=s.model_key
    WHERE s.deleted_at IS NULL AND s.enabled=1
      AND s.space_id=? AND s.model_key=?
      AND (
        (?='record.created' AND s.include_created=1)
        OR (?='record.updated' AND s.include_updated=1)
        OR (?='record.deleted' AND s.include_deleted=1)
      )`)
    .bind(event.space_id, event.model_key, event.event_type, event.event_type, event.event_type)
    .all<{ id: string }>();

  for (const subscription of subscriptions.results) {
    const deliveryId = id("dlv");
    const timestamp = now();
    await env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries(
      id,event_id,subscription_id,status,created_at,updated_at
    ) VALUES(?,?,?,'pending',?,?)`)
      .bind(deliveryId, event.id, subscription.id, timestamp, timestamp).run();

    const delivery = await env.DB.prepare(
      "SELECT id,status FROM webhook_deliveries WHERE event_id=? AND subscription_id=?",
    ).bind(event.id, subscription.id).first<{ id: string; status: string }>();
    if (!delivery || delivery.status === "queued" || delivery.status === "succeeded" || delivery.status === "cancelled") continue;

    await env.EVENT_DELIVERY_QUEUE.send({ kind: "webhook-delivery", deliveryId: delivery.id } satisfies WebhookDeliveryQueueMessage);
    await env.DB.prepare(`UPDATE webhook_deliveries
      SET status='queued',queued_at=?,updated_at=?,last_error=NULL
      WHERE id=? AND status IN ('pending','failed')`)
      .bind(timestamp, timestamp, delivery.id).run();
  }

  await env.DB.prepare(`UPDATE domain_event_outbox
    SET dispatched_at=?,dispatch_attempt_count=dispatch_attempt_count+1,last_dispatch_attempt_at=?,last_dispatch_error=NULL
    WHERE id=? AND dispatched_at IS NULL`)
    .bind(now(), now(), event.id).run();
}

export async function dispatchPendingDomainEvents(env: Bindings, limit = 50): Promise<number> {
  const rows = await env.DB.prepare(`SELECT id,event_type,space_id,model_key,record_id,record_version,occurred_at
    FROM domain_event_outbox WHERE dispatched_at IS NULL ORDER BY occurred_at,id LIMIT ?`)
    .bind(limit).all<OutboxRow>();
  let dispatched = 0;
  for (const event of rows.results) {
    try {
      await dispatchEvent(env, event);
      dispatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "dispatch failed";
      await env.DB.prepare(`UPDATE domain_event_outbox
        SET dispatch_attempt_count=dispatch_attempt_count+1,last_dispatch_attempt_at=?,last_dispatch_error=?
        WHERE id=? AND dispatched_at IS NULL`)
        .bind(now(), message, event.id).run();
      console.error("Domain event dispatch failed", { eventId: event.id, error: message });
    }
  }
  return dispatched;
}

async function loadDelivery(env: Bindings, deliveryId: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(`SELECT d.id,d.event_id,d.subscription_id,d.status,
      s.webhook_url,s.signing_secret,s.enabled AS subscription_enabled,s.application_id,s.model_key
    FROM webhook_deliveries d
    LEFT JOIN event_subscriptions s ON s.id=d.subscription_id AND s.deleted_at IS NULL
    WHERE d.id=?`)
    .bind(deliveryId).first<DeliveryRow>();
}

async function applicationCanReceive(env: Bindings, applicationId: string, modelKey: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS allowed FROM application_model_access
    WHERE application_id=? AND model_key=? LIMIT 1`)
    .bind(applicationId, modelKey).first<{ allowed: number }>();
  return Boolean(row);
}

async function deliverOne(env: Bindings, deliveryId: string): Promise<"ack" | "retry"> {
  const delivery = await loadDelivery(env, deliveryId);
  if (!delivery || delivery.status === "succeeded" || delivery.status === "cancelled") return "ack";
  if (!delivery.webhook_url || !delivery.signing_secret || !delivery.subscription_enabled || !delivery.application_id || !delivery.model_key
      || !(await applicationCanReceive(env, delivery.application_id, delivery.model_key))) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='subscription unavailable or access revoked' WHERE id=?`)
      .bind(now(), deliveryId).run();
    return "ack";
  }
  const event = await env.DB.prepare(`SELECT id,event_type,space_id,model_key,record_id,record_version,occurred_at
    FROM domain_event_outbox WHERE id=?`)
    .bind(delivery.event_id).first<OutboxRow>();
  if (!event) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='event unavailable' WHERE id=?`)
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

export async function sendWebhookTest(url: string, secret: string, subscriptionId: string, spaceId: string, modelKey: string) {
  const body = JSON.stringify({
    id: id("test"),
    type: "subscription.test",
    subscriptionId,
    spaceId,
    modelKey,
    occurredAt: now(),
  });
  const response = await signedFetch(url, secret, body, {
    "x-lifespace-test": "true",
    "x-lifespace-subscription-id": subscriptionId,
  });
  return { ok: response.ok, statusCode: response.status };
}
