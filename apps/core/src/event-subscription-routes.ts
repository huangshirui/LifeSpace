import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { createWebhookSigningSecret, sendWebhookEndpointTest, validateWebhookUrl, type DomainEventType } from "./eventing";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;

type EndpointRow = {
  id: string;
  application_id: string;
  space_id: string;
  subscriber_service_principal_id: string;
  name: string;
  webhook_url: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type SubscriptionRow = {
  id: string;
  endpoint_id: string;
  model_key: string;
  include_created: number;
  include_updated: number;
  include_deleted: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  application_id: string;
  space_id: string;
  subscriber_service_principal_id: string;
};

const createEndpointId = () => `whk_${crypto.randomUUID().replaceAll("-", "")}`;
const createSubscriptionId = () => `sub_${crypto.randomUUID().replaceAll("-", "")}`;
const allowedEvents = new Set<DomainEventType>(["record.created", "record.updated", "record.deleted"]);

function requireUser(principal: Principal): void {
  if (principal.type !== "user") throw new ApiError("USER_REQUIRED", "A user principal is required", 403);
}

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  return value as Body;
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 80) throw new ApiError("INVALID_REQUEST", "name must contain 1-80 characters", 400);
  return value.trim();
}

function servicePrincipalId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 200) {
    throw new ApiError("INVALID_REQUEST", "subscriberServicePrincipalId is required", 400);
  }
  return value.trim();
}

function eventFlags(value: unknown): { created: number; updated: number; deleted: number; eventTypes: DomainEventType[] } {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !allowedEvents.has(item as DomainEventType))) {
    throw new ApiError("INVALID_REQUEST", "eventTypes must contain one or more supported record events", 400);
  }
  const eventTypes = [...new Set(value as DomainEventType[])];
  return {
    created: eventTypes.includes("record.created") ? 1 : 0,
    updated: eventTypes.includes("record.updated") ? 1 : 0,
    deleted: eventTypes.includes("record.deleted") ? 1 : 0,
    eventTypes,
  };
}

function endpointDto(row: EndpointRow) {
  return {
    id: row.id,
    spaceId: row.space_id,
    subscriberServicePrincipalId: row.subscriber_service_principal_id,
    name: row.name,
    destination: { type: "webhook" as const, url: row.webhook_url },
    enabled: Boolean(row.enabled),
    signingConfigured: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriptionDto(row: SubscriptionRow) {
  const eventTypes: DomainEventType[] = [];
  if (row.include_created) eventTypes.push("record.created");
  if (row.include_updated) eventTypes.push("record.updated");
  if (row.include_deleted) eventTypes.push("record.deleted");
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    modelKey: row.model_key,
    eventTypes,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireManager(env: Bindings, principal: Principal, spaceId: string): Promise<void> {
  requireUser(principal);
  await requireSpacePermission(env, principal, spaceId, "manage");
}

async function requireSubscribableModel(env: Bindings, principal: Principal, spaceId: string, modelKey: string): Promise<void> {
  const model = await getRuntimeModel(env, modelKey);
  if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  await requireModelAccess(env, principal, spaceId, model, "read");
}

async function requireSubscriberModelGrant(env: Bindings, spaceId: string, subscriberId: string, modelKey: string): Promise<void> {
  const currentTime = new Date().toISOString();
  const grant = await env.DB.prepare(`SELECT id FROM data_grants
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
    .bind(spaceId, subscriberId, currentTime, modelKey)
    .first<{ id: string }>();
  if (!grant) {
    throw new ApiError(
      "EVENT_SUBSCRIBER_ACCESS_DENIED",
      "The subscriber service principal must have current read access to the selected model in this Space",
      403,
    );
  }
}

async function ownedEndpoint(env: Bindings, principal: Principal, endpointId: string): Promise<EndpointRow> {
  const row = await env.DB.prepare(`SELECT id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,enabled,created_at,updated_at
    FROM webhook_endpoints WHERE id=? AND application_id=? AND deleted_at IS NULL`)
    .bind(endpointId, principal.clientId).first<EndpointRow>();
  if (!row) throw new ApiError("WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook endpoint not found", 404);
  await requireManager(env, principal, row.space_id);
  return row;
}

async function ownedSubscription(env: Bindings, principal: Principal, subscriptionId: string): Promise<SubscriptionRow> {
  const row = await env.DB.prepare(`SELECT s.id,s.endpoint_id,s.model_key,s.include_created,s.include_updated,s.include_deleted,s.enabled,s.created_at,s.updated_at,
      e.application_id,e.space_id,e.subscriber_service_principal_id
    FROM event_subscriptions s
    JOIN webhook_endpoints e ON e.id=s.endpoint_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND e.application_id=?`)
    .bind(subscriptionId, principal.clientId).first<SubscriptionRow>();
  if (!row) throw new ApiError("EVENT_SUBSCRIPTION_NOT_FOUND", "Event subscription not found", 404);
  await requireManager(env, principal, row.space_id);
  return row;
}

export function registerEventSubscriptionRoutes(app: App): void {
  app.get("/api/v1/webhook-endpoints", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const search = new URL(context.req.url).searchParams;
    const spaceId = search.get("spaceId")?.trim();
    const subscriberId = search.get("subscriberServicePrincipalId")?.trim() || null;
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    if (subscriberId && subscriberId.length > 200) throw new ApiError("INVALID_REQUEST", "subscriberServicePrincipalId is invalid", 400);
    await requireManager(context.env, principal, spaceId);
    const rows = subscriberId
      ? await context.env.DB.prepare(`SELECT id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,enabled,created_at,updated_at
          FROM webhook_endpoints
          WHERE application_id=? AND space_id=? AND subscriber_service_principal_id=? AND deleted_at IS NULL
          ORDER BY created_at DESC,id DESC`)
        .bind(principal.clientId, spaceId, subscriberId).all<EndpointRow>()
      : await context.env.DB.prepare(`SELECT id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,enabled,created_at,updated_at
          FROM webhook_endpoints
          WHERE application_id=? AND space_id=? AND deleted_at IS NULL
          ORDER BY created_at DESC,id DESC`)
        .bind(principal.clientId, spaceId).all<EndpointRow>();
    return context.json(success({ items: rows.results.map(endpointDto) }));
  });

  app.post("/api/v1/webhook-endpoints", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const input = await body(context);
    const spaceId = typeof input.spaceId === "string" ? input.spaceId.trim() : "";
    const subscriberId = servicePrincipalId(input.subscriberServicePrincipalId);
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    await requireManager(context.env, principal, spaceId);
    const endpointId = createEndpointId();
    const webhookUrl = validateWebhookUrl(input.webhookUrl);
    const signingSecret = createWebhookSigningSecret();
    const timestamp = new Date().toISOString();
    await context.env.DB.prepare(`INSERT INTO webhook_endpoints(
      id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,signing_secret,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?,?)`)
      .bind(endpointId, principal.clientId, spaceId, subscriberId, displayName(input.name), webhookUrl, signingSecret, principal.id, timestamp, timestamp).run();
    const row = await ownedEndpoint(context.env, principal, endpointId);
    return context.json(success({
      ...endpointDto(row),
      signingSecret,
      signature: "HMAC-SHA256(timestamp + '.' + rawBody); header X-LifeSpace-Signature: v1=<hex>",
    }), 201);
  });

  app.patch("/api/v1/webhook-endpoints/:endpointId", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedEndpoint(context.env, principal, context.req.param("endpointId"));
    const input = await body(context);
    const nextName = input.name === undefined ? current.name : displayName(input.name);
    const nextUrl = input.webhookUrl === undefined ? current.webhook_url : validateWebhookUrl(input.webhookUrl);
    const enabled = input.enabled === undefined ? current.enabled : (typeof input.enabled === "boolean" ? Number(input.enabled) : NaN);
    if (!Number.isInteger(enabled)) throw new ApiError("INVALID_REQUEST", "enabled must be boolean", 400);
    const rotate = input.rotateSigningSecret === true;
    if (input.rotateSigningSecret !== undefined && typeof input.rotateSigningSecret !== "boolean") throw new ApiError("INVALID_REQUEST", "rotateSigningSecret must be boolean", 400);
    const rotatedSecret = rotate ? createWebhookSigningSecret() : null;
    const timestamp = new Date().toISOString();
    await context.env.DB.prepare(`UPDATE webhook_endpoints SET
      name=?,webhook_url=?,enabled=?,signing_secret=CASE WHEN ? IS NULL THEN signing_secret ELSE ? END,updated_at=?
      WHERE id=? AND application_id=? AND deleted_at IS NULL`)
      .bind(nextName, nextUrl, enabled, rotatedSecret, rotatedSecret, timestamp, current.id, principal.clientId).run();
    const updated = await ownedEndpoint(context.env, principal, current.id);
    return context.json(success({ ...endpointDto(updated), ...(rotatedSecret ? { signingSecret: rotatedSecret } : {}) }));
  });

  app.delete("/api/v1/webhook-endpoints/:endpointId", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedEndpoint(context.env, principal, context.req.param("endpointId"));
    const timestamp = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE event_subscriptions SET enabled=0,deleted_at=?,updated_at=? WHERE endpoint_id=? AND deleted_at IS NULL`)
        .bind(timestamp, timestamp, current.id),
      context.env.DB.prepare(`UPDATE webhook_endpoints SET enabled=0,deleted_at=?,updated_at=? WHERE id=? AND application_id=? AND deleted_at IS NULL`)
        .bind(timestamp, timestamp, current.id, principal.clientId),
    ]);
    return context.body(null, 204);
  });

  app.post("/api/v1/webhook-endpoints/:endpointId/test", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedEndpoint(context.env, principal, context.req.param("endpointId"));
    const secret = await context.env.DB.prepare("SELECT signing_secret FROM webhook_endpoints WHERE id=?")
      .bind(current.id).first<{ signing_secret: string }>();
    if (!secret) throw new ApiError("WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook endpoint not found", 404);
    try {
      return context.json(success(await sendWebhookEndpointTest(
        current.webhook_url,
        secret.signing_secret,
        current.id,
        current.space_id,
        current.subscriber_service_principal_id,
      )));
    } catch (error) {
      console.warn("Webhook endpoint test failed", { endpointId: current.id, error: error instanceof Error ? error.message : String(error) });
      throw new ApiError("WEBHOOK_TEST_FAILED", "Webhook test request failed", 502);
    }
  });

  app.get("/api/v1/webhook-endpoints/:endpointId/deliveries", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedEndpoint(context.env, principal, context.req.param("endpointId"));
    const rows = await context.env.DB.prepare(`SELECT d.id,d.event_id,d.status,d.attempt_count,d.queued_at,d.delivered_at,d.last_status_code,d.last_error,d.created_at,
        e.event_type,e.model_key,e.record_id,e.record_version,e.change_id,e.occurred_at
      FROM webhook_deliveries d
      JOIN event_subscriptions s ON s.id=d.subscription_id
      JOIN domain_event_outbox e ON e.id=d.event_id
      WHERE s.endpoint_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT 50`)
      .bind(current.id).all<Record<string, unknown>>();
    return context.json(success({ items: rows.results.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      modelKey: row.model_key,
      recordId: row.record_id,
      recordVersion: row.record_version,
      changeId: row.change_id,
      occurredAt: row.occurred_at,
      status: row.status,
      attemptCount: row.attempt_count,
      queuedAt: row.queued_at,
      deliveredAt: row.delivered_at,
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      createdAt: row.created_at,
    })) }));
  });

  app.get("/api/v1/event-subscriptions", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const endpointId = new URL(context.req.url).searchParams.get("endpointId")?.trim();
    if (!endpointId) throw new ApiError("INVALID_REQUEST", "endpointId is required", 400);
    const endpoint = await ownedEndpoint(context.env, principal, endpointId);
    const rows = await context.env.DB.prepare(`SELECT s.id,s.endpoint_id,s.model_key,s.include_created,s.include_updated,s.include_deleted,s.enabled,s.created_at,s.updated_at,
        e.application_id,e.space_id,e.subscriber_service_principal_id
      FROM event_subscriptions s JOIN webhook_endpoints e ON e.id=s.endpoint_id
      WHERE s.endpoint_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
      ORDER BY s.created_at DESC,s.id DESC`)
      .bind(endpoint.id).all<SubscriptionRow>();
    return context.json(success({ items: rows.results.map(subscriptionDto) }));
  });

  app.post("/api/v1/event-subscriptions", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const input = await body(context);
    const endpointId = typeof input.endpointId === "string" ? input.endpointId.trim() : "";
    const modelKey = typeof input.modelKey === "string" ? input.modelKey.trim() : "";
    if (!endpointId || !modelKey) throw new ApiError("INVALID_REQUEST", "endpointId and modelKey are required", 400);
    const endpoint = await ownedEndpoint(context.env, principal, endpointId);
    await requireSubscribableModel(context.env, principal, endpoint.space_id, modelKey);
    await requireSubscriberModelGrant(context.env, endpoint.space_id, endpoint.subscriber_service_principal_id, modelKey);
    const existing = await context.env.DB.prepare("SELECT id FROM event_subscriptions WHERE endpoint_id=? AND model_key=? AND deleted_at IS NULL LIMIT 1")
      .bind(endpoint.id, modelKey).first<{ id: string }>();
    if (existing) throw new ApiError("EVENT_SUBSCRIPTION_EXISTS", "This endpoint already subscribes to the selected model", 409);
    const flags = eventFlags(input.eventTypes);
    const subscriptionId = createSubscriptionId();
    const timestamp = new Date().toISOString();
    await context.env.DB.prepare(`INSERT INTO event_subscriptions(
      id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,1,?,?,?)`)
      .bind(subscriptionId, endpoint.id, modelKey, flags.created, flags.updated, flags.deleted, principal.id, timestamp, timestamp).run();
    const row = await ownedSubscription(context.env, principal, subscriptionId);
    return context.json(success(subscriptionDto(row)), 201);
  });

  app.patch("/api/v1/event-subscriptions/:subscriptionId", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedSubscription(context.env, principal, context.req.param("subscriptionId"));
    const input = await body(context);
    const flags = input.eventTypes === undefined ? null : eventFlags(input.eventTypes);
    const enabled = input.enabled === undefined ? current.enabled : (typeof input.enabled === "boolean" ? Number(input.enabled) : NaN);
    if (!Number.isInteger(enabled)) throw new ApiError("INVALID_REQUEST", "enabled must be boolean", 400);
    if (enabled || flags) {
      await requireSubscribableModel(context.env, principal, current.space_id, current.model_key);
      await requireSubscriberModelGrant(context.env, current.space_id, current.subscriber_service_principal_id, current.model_key);
    }
    const timestamp = new Date().toISOString();
    await context.env.DB.prepare(`UPDATE event_subscriptions SET
      include_created=?,include_updated=?,include_deleted=?,enabled=?,updated_at=?
      WHERE id=? AND deleted_at IS NULL`)
      .bind(flags?.created ?? current.include_created, flags?.updated ?? current.include_updated, flags?.deleted ?? current.include_deleted,
        enabled, timestamp, current.id).run();
    return context.json(success(subscriptionDto(await ownedSubscription(context.env, principal, current.id))));
  });

  app.delete("/api/v1/event-subscriptions/:subscriptionId", requireScope("spaces:manage"), async (context) => {
    const principal = context.get("principal");
    requireUser(principal);
    const current = await ownedSubscription(context.env, principal, context.req.param("subscriptionId"));
    const timestamp = new Date().toISOString();
    await context.env.DB.prepare(`UPDATE event_subscriptions SET enabled=0,deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL`)
      .bind(timestamp, timestamp, current.id).run();
    return context.body(null, 204);
  });
}
