import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { processWebhookDeliveryQueue, type WebhookDeliveryQueueMessage } from "../src/eventing";

type TestEnv = { DB: D1Database };
type DeliveryState = { status: string; attempt_count: number; last_error: string | null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function identityFetcher(result: "active" | "inactive" | "unavailable", calls: Array<{ url: string; secret: string | null }>): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      calls.push({ url: request.url, secret: request.headers.get("x-lifespace-internal-secret") });
      if (result === "unavailable") return new Response("unavailable", { status: 503 });
      return Response.json({ data: { active: result === "active" } });
    },
  } as unknown as Fetcher;
}

async function fixture(identityState: "active" | "inactive" | "unavailable") {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  const spaceId = `spc_${suffix}`;
  const applicationId = `app_eventing_${suffix}`;
  const subscriberId = `svc_${suffix}`;
  const endpointId = `wep_${suffix}`;
  const subscriptionId = `sub_${suffix}`;
  const eventId = `evt_${suffix}`;
  const deliveryId = `dlv_${suffix}`;
  const grantId = `grt_${suffix}`;
  const userId = `usr_${suffix}`;
  const identityCalls: Array<{ url: string; secret: string | null }> = [];

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Eventing subscriber authority", userId, now, now, "Asia/Shanghai"),
    db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "task", "read", "user", userId, now, now),
    db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(grantId, spaceId, "service", subscriberId, "model", "task", "read", userId, now),
    db.prepare(`INSERT INTO webhook_endpoints(
      id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,signing_secret,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?,?)`).bind(
      endpointId,
      applicationId,
      spaceId,
      subscriberId,
      "Subscriber authority test",
      "https://automation.example.com/hooks/lifespace",
      "a".repeat(64),
      userId,
      now,
      now,
    ),
    db.prepare(`INSERT INTO event_subscriptions(
      id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,1,0,0,1,?,?,?)`).bind(subscriptionId, endpointId, "task", userId, now, now),
    db.prepare(`INSERT INTO domain_event_outbox(
      id,event_type,space_id,model_key,record_id,record_version,actor_type,actor_id,occurred_at,dispatched_at
    ) VALUES(?,'record.created',?,?,?,1,'user',?,?,?)`).bind(
      eventId,
      spaceId,
      "task",
      `rec_${suffix}`,
      userId,
      now,
      now,
    ),
    db.prepare(`INSERT INTO webhook_deliveries(
      id,event_id,subscription_id,status,queued_at,created_at,updated_at
    ) VALUES(?,?,?,'queued',?,?,?)`).bind(deliveryId, eventId, subscriptionId, now, now, now),
  ]);

  const bindings = {
    DB: db,
    IDENTITY: identityFetcher(identityState, identityCalls),
    CORE_IDENTITY_SHARED_SECRET: "test-core-identity-shared-secret-at-least-32",
  } as Bindings;

  return { db, bindings, deliveryId, grantId, subscriberId, identityCalls };
}

async function processOne(bindings: Bindings, deliveryId: string) {
  let acked = false;
  let retried = false;
  const message = {
    body: { kind: "webhook-delivery", deliveryId } satisfies WebhookDeliveryQueueMessage,
    ack() { acked = true; },
    retry() { retried = true; },
  };
  await processWebhookDeliveryQueue({ messages: [message] } as unknown as MessageBatch<WebhookDeliveryQueueMessage>, bindings);
  return { acked, retried };
}

async function deliveryState(db: D1Database, deliveryId: string) {
  return db.prepare("SELECT status,attempt_count,last_error FROM webhook_deliveries WHERE id=?")
    .bind(deliveryId).first<DeliveryState>();
}

describe("Eventing subscriber current authority", () => {
  it("delivers when Core authority and the current Identity principal are active", async () => {
    const f = await fixture("active");
    const webhookFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", webhookFetch);

    const result = await processOne(f.bindings, f.deliveryId);

    expect(result).toEqual({ acked: true, retried: false });
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    expect(f.identityCalls).toHaveLength(1);
    expect(f.identityCalls[0]).toEqual({
      url: `https://identity.internal/introspection/v1/service-principals/${f.subscriberId}`,
      secret: f.bindings.CORE_IDENTITY_SHARED_SECRET,
    });
    expect(await deliveryState(f.db, f.deliveryId)).toMatchObject({ status: "succeeded", attempt_count: 1, last_error: null });
  });

  it("cancels and acknowledges a queued delivery when the subscriber principal is inactive even if its Grant remains", async () => {
    const f = await fixture("inactive");
    const webhookFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", webhookFetch);

    const result = await processOne(f.bindings, f.deliveryId);

    expect(result).toEqual({ acked: true, retried: false });
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(await deliveryState(f.db, f.deliveryId)).toMatchObject({
      status: "cancelled",
      attempt_count: 0,
      last_error: "subscriber service principal inactive",
    });
    const grant = await f.db.prepare("SELECT revoked_at FROM data_grants WHERE id=?").bind(f.grantId).first<{ revoked_at: string | null }>();
    expect(grant?.revoked_at).toBeNull();
  });

  it("fails closed and retries later when current Identity status cannot be confirmed", async () => {
    const f = await fixture("unavailable");
    const webhookFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", webhookFetch);

    const result = await processOne(f.bindings, f.deliveryId);

    expect(result).toEqual({ acked: false, retried: true });
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(await deliveryState(f.db, f.deliveryId)).toMatchObject({ status: "failed", attempt_count: 0 });
    expect((await deliveryState(f.db, f.deliveryId))?.last_error).toContain("subscriber identity status unavailable");
  });
});
