import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import {
  dispatchPendingDomainEvents,
  processWebhookDeliveryQueue,
  type WebhookDeliveryQueueMessage,
} from "../src/eventing";

type TestEnv = { DB: D1Database };

afterEach(() => vi.unstubAllGlobals());

function activeIdentity(): Fetcher {
  return {
    async fetch() {
      return Response.json({ data: { active: true, displayName: "Batch subscriber" } });
    },
  } as unknown as Fetcher;
}

describe("ChangeSet Eventing aggregation", () => {
  it("keeps per-event delivery evidence but sends one callback per endpoint", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    const spaceId = `spc_${suffix}`;
    const userId = `usr_${suffix}`;
    const applicationId = `app_${suffix}`;
    const subscriberId = `svc_${suffix}`;
    const endpointId = `wep_${suffix}`;
    const subscriptionId = `sub_${suffix}`;
    const changeSetId = `cgs_${suffix}`;

    const setup = [
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(spaceId, "Batch Eventing", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO application_model_access(
        application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "task", "read", "user", userId, now, now),
      db.prepare(`INSERT INTO data_grants(
        id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
        `grt_${suffix}`, spaceId, "service", subscriberId, "model", "task", "read", userId, now,
      ),
      db.prepare(`INSERT INTO webhook_endpoints(
        id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,signing_secret,
        enabled,created_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,1,?,?,?)`).bind(
        endpointId, applicationId, spaceId, subscriberId, "Batch endpoint",
        "https://automation.example.com/hooks/batch", "b".repeat(64), userId, now, now,
      ),
      db.prepare(`INSERT INTO event_subscriptions(
        id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,
        created_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,1,0,0,1,?,?,?)`).bind(
        subscriptionId, endpointId, "task", userId, now, now,
      ),
    ];
    for (let index = 0; index < 3; index += 1) {
      setup.push(db.prepare(`INSERT INTO domain_event_outbox(
        id,event_type,space_id,model_key,record_id,record_version,change_id,change_set_id,
        actor_type,actor_id,occurred_at
      ) VALUES(?,'record.created',?,?,?,1,?,?, 'user',?,?)`).bind(
        `evt_${suffix}_${index}`,
        spaceId,
        "task",
        `rec_${suffix}_${index}`,
        `chg_${suffix}_${index}`,
        changeSetId,
        userId,
        now,
      ));
    }
    await db.batch(setup);

    const queued: WebhookDeliveryQueueMessage[] = [];
    const bindings = {
      DB: db,
      EVENT_DELIVERY_QUEUE: {
        async send(message: WebhookDeliveryQueueMessage) { queued.push(message); },
      },
      IDENTITY: activeIdentity(),
      CORE_IDENTITY_SHARED_SECRET: "test-core-identity-shared-secret-at-least-32",
    } as unknown as Bindings;

    expect(await dispatchPendingDomainEvents(bindings)).toBe(3);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "webhook-delivery-batch",
      changeSetId,
      endpointId,
    });
    if (queued[0]?.kind !== "webhook-delivery-batch") throw new Error("Expected batch delivery");
    expect(queued[0].deliveryIds).toHaveLength(3);

    const webhookFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.type).toBe("change_set.committed");
      expect(payload.changeSetId).toBe(changeSetId);
      expect(payload.events).toHaveLength(3);
      expect(new Set(payload.events.map((event: any) => event.id)).size).toBe(3);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", webhookFetch);

    let acked = false;
    let retried = false;
    const message = {
      body: queued[0],
      ack() { acked = true; },
      retry() { retried = true; },
    };
    await processWebhookDeliveryQueue(
      { messages: [message] } as unknown as MessageBatch<WebhookDeliveryQueueMessage>,
      bindings,
    );

    expect(webhookFetch).toHaveBeenCalledTimes(1);
    expect({ acked, retried }).toEqual({ acked: true, retried: false });
    const deliveries = await db.prepare(`SELECT status,attempt_count
      FROM webhook_deliveries WHERE subscription_id=? ORDER BY event_id`)
      .bind(subscriptionId)
      .all<{ status: string; attempt_count: number }>();
    expect(deliveries.results).toHaveLength(3);
    expect(deliveries.results.every((row) => row.status === "succeeded" && row.attempt_count === 1)).toBe(true);
  });
});
