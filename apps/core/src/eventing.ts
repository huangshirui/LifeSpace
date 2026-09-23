import type { Bindings } from "./env";
import { ApiError } from "./http";
import { servicePrincipalIsActive } from "./service-principal-authority";

export type DomainEventType = "record.created" | "record.updated" | "record.deleted";
export type WebhookDeliveryQueueMessage = { kind: "webhook-delivery"; deliveryId: string };

type OutboxRow = {
  id: string;
  event_type: DomainEventType;
  space_id: string;
  model_key: string;
  record_id: string;
  record_version: number;
  change_id: string | null;
  operation_group_id: string | null;
  operation_group_ordinal: number | null;
  occurred_at: string;
  dispatched_at?: string | null;
};

type DeliveryRow = {
  id: string;
  status: "pending" | "queued" | "succeeded" | "failed" | "cancelled";
  endpoint_id: string | null;
  operation_group_id: string | null;
  event_count: number;
  webhook_url: string | null;
  signing_secret: string | null;
  endpoint_enabled: number | null;
  application_id: string | null;
  subscriber_service_principal_id: string | null;
  space_id: string | null;
};

type DeliveryMatch = {
  event_id: string;
  subscription_id: string;
  endpoint_id: string;
  ordinal: number;
};

type DeliveryEventRow = OutboxRow & {
  subscription_id: string;
  delivery_ordinal: number;
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

async function matchingSubscriptions(env: Bindings, events: readonly OutboxRow[]): Promise<DeliveryMatch[]> {
  if (!events.length) return [];
  const placeholders = events.map(() => "?").join(",");
  const currentTime = now();
  const matches = await env.DB.prepare(`SELECT
      o.id AS event_id,
      s.id AS subscription_id,
      s.endpoint_id,
      COALESCE(o.operation_group_ordinal,0) AS ordinal
    FROM domain_event_outbox o
    JOIN event_subscriptions s ON s.model_key=o.model_key
    JOIN webhook_endpoints e ON e.id=s.endpoint_id
    JOIN application_model_access ama
      ON ama.application_id=e.application_id AND ama.model_key=o.model_key
    WHERE o.id IN (${placeholders})
      AND s.deleted_at IS NULL AND s.enabled=1
      AND e.deleted_at IS NULL AND e.enabled=1
      AND e.space_id=o.space_id
      AND (
        (o.event_type='record.created' AND s.include_created=1)
        OR (o.event_type='record.updated' AND s.include_updated=1)
        OR (o.event_type='record.deleted' AND s.include_deleted=1)
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
            (g.resource_type='model' AND g.resource_id=o.model_key)
            OR (g.resource_type='space' AND g.resource_id IS NULL)
          )
      )
    ORDER BY COALESCE(o.operation_group_ordinal,0),o.occurred_at,o.id,s.id`)
    .bind(...events.map((event) => event.id), currentTime)
    .all<DeliveryMatch>();
  return matches.results;
}

async function queueEndpointDelivery(
  env: Bindings,
  events: readonly OutboxRow[],
  endpointId: string,
  matches: readonly DeliveryMatch[],
): Promise<void> {
  const operationGroupId = events[0]?.operation_group_id ?? null;
  const anchor = matches[0];
  if (!anchor) return;
  const deliveryKey = operationGroupId
    ? `grp:${operationGroupId}:${endpointId}`
    : `evt:${anchor.event_id}:${anchor.subscription_id}`;
  const candidateId = id("dlv");
  const timestamp = now();

  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries(
      id,event_id,subscription_id,status,created_at,updated_at,
      endpoint_id,delivery_key,operation_group_id,event_count
    ) VALUES(?,?,?,'pending',?,?,?,?,?,?)`)
    .bind(
      candidateId,
      anchor.event_id,
      anchor.subscription_id,
      timestamp,
      timestamp,
      endpointId,
      deliveryKey,
      operationGroupId,
      matches.length,
    ).run();

  const delivery = await env.DB.prepare(
    "SELECT id,status FROM webhook_deliveries WHERE delivery_key=?",
  ).bind(deliveryKey).first<{ id: string; status: string }>();
  if (!delivery) return;

  await env.DB.batch(matches.map((match, ordinal) =>
    env.DB.prepare(`INSERT OR IGNORE INTO webhook_delivery_events(
      delivery_id,event_id,subscription_id,ordinal
    ) VALUES(?,?,?,?)`).bind(delivery.id, match.event_id, match.subscription_id, ordinal)
  ));
  await env.DB.prepare(`UPDATE webhook_deliveries
    SET endpoint_id=COALESCE(endpoint_id,?),operation_group_id=COALESCE(operation_group_id,?),
        event_count=?,updated_at=?
    WHERE id=?`)
    .bind(endpointId, operationGroupId, matches.length, timestamp, delivery.id).run();

  if (delivery.status === "queued" || delivery.status === "succeeded" || delivery.status === "cancelled") return;

  await env.EVENT_DELIVERY_QUEUE.send({ kind: "webhook-delivery", deliveryId: delivery.id } satisfies WebhookDeliveryQueueMessage);
  await env.DB.prepare(`UPDATE webhook_deliveries
    SET status='queued',queued_at=?,updated_at=?,last_error=NULL
    WHERE id=? AND status IN ('pending','failed')`)
    .bind(timestamp, timestamp, delivery.id).run();
}

async function markEventsDispatched(env: Bindings, events: readonly OutboxRow[]): Promise<void> {
  if (!events.length) return;
  const placeholders = events.map(() => "?").join(",");
  const timestamp = now();
  await env.DB.prepare(`UPDATE domain_event_outbox
    SET dispatched_at=?,dispatch_attempt_count=dispatch_attempt_count+1,last_dispatch_attempt_at=?,last_dispatch_error=NULL
    WHERE id IN (${placeholders}) AND dispatched_at IS NULL`)
    .bind(timestamp, timestamp, ...events.map((event) => event.id)).run();
}

async function dispatchEvents(env: Bindings, events: readonly OutboxRow[]): Promise<void> {
  const matches = await matchingSubscriptions(env, events);
  const byEndpoint = new Map<string, DeliveryMatch[]>();
  for (const match of matches) {
    const list = byEndpoint.get(match.endpoint_id) ?? [];
    list.push(match);
    byEndpoint.set(match.endpoint_id, list);
  }
  for (const [endpointId, endpointMatches] of byEndpoint) {
    await queueEndpointDelivery(env, events, endpointId, endpointMatches);
  }
  await markEventsDispatched(env, events);
}

async function operationGroupEvents(env: Bindings, operationGroupId: string): Promise<OutboxRow[]> {
  const rows = await env.DB.prepare(`SELECT
      id,event_type,space_id,model_key,record_id,record_version,change_id,
      operation_group_id,operation_group_ordinal,occurred_at,dispatched_at
    FROM domain_event_outbox
    WHERE operation_group_id=?
    ORDER BY operation_group_ordinal,occurred_at,id`)
    .bind(operationGroupId).all<OutboxRow>();
  return rows.results;
}

async function markDispatchFailure(env: Bindings, events: readonly OutboxRow[], message: string): Promise<void> {
  if (!events.length) return;
  const placeholders = events.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE domain_event_outbox
    SET dispatch_attempt_count=dispatch_attempt_count+1,last_dispatch_attempt_at=?,last_dispatch_error=?
    WHERE id IN (${placeholders}) AND dispatched_at IS NULL`)
    .bind(now(), message, ...events.map((event) => event.id)).run();
}

export async function dispatchPendingDomainEvents(env: Bindings, limit = 50): Promise<number> {
  const rows = await env.DB.prepare(`SELECT
      id,event_type,space_id,model_key,record_id,record_version,change_id,
      operation_group_id,operation_group_ordinal,occurred_at,dispatched_at
    FROM domain_event_outbox
    WHERE dispatched_at IS NULL
    ORDER BY occurred_at,id
    LIMIT ?`)
    .bind(limit).all<OutboxRow>();

  let dispatched = 0;
  const handledGroups = new Set<string>();
  for (const seed of rows.results) {
    if (seed.operation_group_id && handledGroups.has(seed.operation_group_id)) continue;
    const events = seed.operation_group_id
      ? await operationGroupEvents(env, seed.operation_group_id)
      : [seed];
    if (seed.operation_group_id) handledGroups.add(seed.operation_group_id);
    const pendingCount = events.filter((event) => !event.dispatched_at).length;
    try {
      await dispatchEvents(env, events);
      dispatched += pendingCount;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "dispatch failed";
      await markDispatchFailure(env, events, message);
      console.error("Domain event dispatch failed", {
        eventIds: events.map((event) => event.id),
        operationGroupId: seed.operation_group_id,
        error: message,
      });
    }
  }
  return dispatched;
}

async function loadDelivery(env: Bindings, deliveryId: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(`SELECT
      d.id,d.status,
      COALESCE(d.endpoint_id,s.endpoint_id) AS endpoint_id,
      d.operation_group_id,d.event_count,
      e.webhook_url,e.signing_secret,e.enabled AS endpoint_enabled,
      e.application_id,e.subscriber_service_principal_id,e.space_id
    FROM webhook_deliveries d
    LEFT JOIN event_subscriptions s ON s.id=d.subscription_id
    LEFT JOIN webhook_endpoints e
      ON e.id=COALESCE(d.endpoint_id,s.endpoint_id) AND e.deleted_at IS NULL
    WHERE d.id=?`)
    .bind(deliveryId).first<DeliveryRow>();
}

async function authorizedDeliveryEvents(env: Bindings, delivery: DeliveryRow): Promise<DeliveryEventRow[]> {
  if (!delivery.endpoint_id || !delivery.application_id || !delivery.subscriber_service_principal_id || !delivery.space_id) return [];
  const rows = await env.DB.prepare(`WITH refs AS (
      SELECT event_id,subscription_id,ordinal
      FROM webhook_delivery_events
      WHERE delivery_id=?
      UNION ALL
      SELECT d.event_id,d.subscription_id,0
      FROM webhook_deliveries d
      WHERE d.id=?
        AND NOT EXISTS(SELECT 1 FROM webhook_delivery_events WHERE delivery_id=?)
    )
    SELECT
      o.id,o.event_type,o.space_id,o.model_key,o.record_id,o.record_version,o.change_id,
      o.operation_group_id,o.operation_group_ordinal,o.occurred_at,
      r.subscription_id,r.ordinal AS delivery_ordinal
    FROM refs r
    JOIN domain_event_outbox o ON o.id=r.event_id
    JOIN event_subscriptions s ON s.id=r.subscription_id
    JOIN application_model_access ama
      ON ama.application_id=? AND ama.model_key=o.model_key
    WHERE s.endpoint_id=?
      AND s.deleted_at IS NULL AND s.enabled=1
      AND s.model_key=o.model_key
      AND o.space_id=?
      AND (
        (o.event_type='record.created' AND s.include_created=1)
        OR (o.event_type='record.updated' AND s.include_updated=1)
        OR (o.event_type='record.deleted' AND s.include_deleted=1)
      )
      AND EXISTS (
        SELECT 1 FROM data_grants g
        WHERE g.source_space_id=o.space_id
          AND g.grantee_type='service'
          AND g.grantee_id=?
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>?)
          AND g.permission IN ('read','write','manage')
          AND (
            (g.resource_type='model' AND g.resource_id=o.model_key)
            OR (g.resource_type='space' AND g.resource_id IS NULL)
          )
      )
    ORDER BY r.ordinal,o.occurred_at,o.id`)
    .bind(
      delivery.id,
      delivery.id,
      delivery.id,
      delivery.application_id,
      delivery.endpoint_id,
      delivery.space_id,
      delivery.subscriber_service_principal_id,
      now(),
    )
    .all<DeliveryEventRow>();
  return rows.results;
}

async function cancelDelivery(env: Bindings, deliveryId: string, reason: string): Promise<"ack"> {
  await env.DB.prepare("UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error=? WHERE id=?")
    .bind(now(), reason, deliveryId).run();
  return "ack";
}

async function deliverOne(env: Bindings, deliveryId: string): Promise<"ack" | "retry"> {
  const delivery = await loadDelivery(env, deliveryId);
  if (!delivery || delivery.status === "succeeded" || delivery.status === "cancelled") return "ack";
  if (!delivery.endpoint_id || !delivery.webhook_url || !delivery.signing_secret || !delivery.endpoint_enabled
      || !delivery.application_id || !delivery.subscriber_service_principal_id || !delivery.space_id) {
    return cancelDelivery(env, deliveryId, "endpoint unavailable or access revoked");
  }

  const events = await authorizedDeliveryEvents(env, delivery);
  if (!events.length) {
    return cancelDelivery(env, deliveryId, "endpoint/subscription unavailable or access revoked");
  }

  let subscriberActive: boolean;
  try {
    subscriberActive = await servicePrincipalIsActive(env, delivery.subscriber_service_principal_id);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "subscriber identity status unavailable";
    await env.DB.prepare("UPDATE webhook_deliveries SET status='failed',updated_at=?,last_error=? WHERE id=?")
      .bind(now(), `subscriber identity status unavailable: ${message}`, deliveryId).run();
    console.error("Webhook subscriber identity check failed", {
      deliveryId,
      subscriberId: delivery.subscriber_service_principal_id,
      error: message,
    });
    return "retry";
  }
  if (!subscriberActive) {
    return cancelDelivery(env, deliveryId, "subscriber service principal inactive");
  }

  const payloads = events.map(eventPayload);
  const grouped = Boolean(delivery.operation_group_id);
  const body = JSON.stringify(grouped ? { events: payloads } : payloads[0]);
  const headers: Record<string, string> = {
    "x-lifespace-delivery-id": delivery.id,
    "x-lifespace-webhook-endpoint-id": delivery.endpoint_id,
    "x-lifespace-event-count": String(payloads.length),
  };
  if (grouped && delivery.operation_group_id) {
    headers["x-lifespace-operation-group-id"] = delivery.operation_group_id;
  } else {
    headers["x-lifespace-event-id"] = events[0]!.id;
    headers["x-lifespace-subscription-id"] = events[0]!.subscription_id;
  }

  const attemptedAt = now();
  await env.DB.prepare("UPDATE webhook_deliveries SET attempt_count=attempt_count+1,event_count=?,updated_at=? WHERE id=?")
    .bind(payloads.length, attemptedAt, deliveryId).run();
  try {
    const response = await signedFetch(delivery.webhook_url, delivery.signing_secret, body, headers);
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
    await env.DB.prepare("UPDATE webhook_deliveries SET status='failed',last_error=?,updated_at=? WHERE id=?")
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
