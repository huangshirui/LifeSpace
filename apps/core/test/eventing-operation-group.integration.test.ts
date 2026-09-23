import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import {
  dispatchPendingDomainEvents,
  processWebhookDeliveryQueue,
  type WebhookDeliveryQueueMessage,
} from "../src/eventing";

type TestEnv = { DB: D1Database };

afterEach(() => {
  vi.unstubAllGlobals();
});

function identityFetcher(calls: string[]): Fetcher {
  return {
    async fetch(input: RequestInfo | URL) {
      const request = new Request(input);
      calls.push(request.url);
      return Response.json({ data: { active: true, displayName: "Batch subscriber" } });
    },
  } as unknown as Fetcher;
}

function queueCollector(messages: WebhookDeliveryQueueMessage[]): Queue {
  return {
    async send(message: WebhookDeliveryQueueMessage) {
      messages.push(message);
    },
  } as unknown as Queue;
}

async function fixture() {
  const DB = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const timestamp = "2026-09-23T10:00:00.000Z";
  const spaceId = `spc_evtgrp_${suffix}`;
  const applicationId = `app_evtgrp_${suffix}`;
  const subscriberId = `svc_evtgrp_${suffix}`;
  const endpointId = `whk_evtgrp_${suffix}`;
  const eventSubscriptionId = `sub_event_${suffix}`;
  const taskSubscriptionId = `sub_task_${suffix}`;
  const userId = `usr_evtgrp_${suffix}`;
  const grantId = `grt_evtgrp_${suffix}`;
  const operationGroupId = `opg_${suffix}`;
  const queued: WebhookDeliveryQueueMessage[] = [];
  const identityCalls: string[] = [];

  await DB.batch([
    DB.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Grouped Event Delivery", userId, timestamp, timestamp, "Asia/Shanghai"),
    DB.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "event", "read", "user", userId, timestamp, timestamp),
    DB.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "task", "read", "user", userId, timestamp, timestamp),
    DB.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(grantId, spaceId, "service", subscriberId, "space", null, "read", userId, timestamp),
    DB.prepare(`INSERT INTO webhook_endpoints(
      id,application_id,space_id,subscriber_service_principal_id,name,webhook_url,signing_secret,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?,?)`).bind(
      endpointId,
      applicationId,
      spaceId,
      subscriberId,
      "Grouped delivery endpoint",
      "https://automation.example.com/hooks/lifespace-grouped",
      "b".repeat(64),
      userId,
      timestamp,
      timestamp,
    ),
    DB.prepare(`INSERT INTO event_subscriptions(
      id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,1,0,0,1,?,?,?)`).bind(eventSubscriptionId, endpointId, "event", userId, timestamp, timestamp),
    DB.prepare(`INSERT INTO event_subscriptions(
      id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,1,0,0,1,?,?,?)`).bind(taskSubscriptionId, endpointId, "task", userId, timestamp, timestamp),
  ]);

  const bindings = {
    DB,
    EVENT_DELIVERY_QUEUE: queueCollector(queued),
    IDENTITY: identityFetcher(identityCalls),
    CORE_IDENTITY_SHARED_SECRET: "test-core-identity-shared-secret-at-least-32",
  } as Bindings;

  async function insertEvent(args: {
    eventId: string;
    modelKey: "event" | "task";
    recordId: string;
    occurredAt: string;
    operationGroupId?: string;
    ordinal?: number;
  }) {
    await DB.prepare(`INSERT INTO domain_event_outbox(
      id,event_type,space_id,model_key,record_id,record_version,change_id,
      actor_type,actor_id,occurred_at,operation_group_id,operation_group_ordinal
    ) VALUES(?,'record.created',?,?,?,1,NULL,'user',?,?,?,?)`)
      .bind(
        args.eventId,
        spaceId,
        args.modelKey,
        args.recordId,
        userId,
        args.occurredAt,
        args.operationGroupId ?? null,
        args.ordinal ?? null,
      ).run();
  }

  return {
    DB,
    bindings,
    queued,
    identityCalls,
    operationGroupId,
    endpointId,
    insertEvent,
  };
}

async function processOne(bindings: Bindings, messageBody: WebhookDeliveryQueueMessage) {
  let acked = false;
  let retried = false;
  const message = {
    body: messageBody,
    ack() { acked = true; },
    retry() { retried = true; },
  };
  await processWebhookDeliveryQueue(
    { messages: [message] } as unknown as MessageBatch<WebhookDeliveryQueueMessage>,
    bindings,
  );
  return { acked, retried };
}

describe("Eventing explicit operation grouping", () => {
  it("delivers one grouped callback for Batch events and never time-coalesces independent events", async () => {
    const f = await fixture();
    await f.insertEvent({
      eventId: `evt_group_event_${crypto.randomUUID().replaceAll("-", "")}`,
      modelKey: "event",
      recordId: `rec_group_event_${crypto.randomUUID().replaceAll("-", "")}`,
      occurredAt: "2026-09-23T10:00:00.001Z",
      operationGroupId: f.operationGroupId,
      ordinal: 0,
    });
    await f.insertEvent({
      eventId: `evt_group_task_${crypto.randomUUID().replaceAll("-", "")}`,
      modelKey: "task",
      recordId: `rec_group_task_${crypto.randomUUID().replaceAll("-", "")}`,
      occurredAt: "2026-09-23T10:00:00.002Z",
      operationGroupId: f.operationGroupId,
      ordinal: 1,
    });

    expect(await dispatchPendingDomainEvents(f.bindings)).toBe(2);
    expect(f.queued).toHaveLength(1);

    const groupedDelivery = await f.DB.prepare(`SELECT id,operation_group_id,event_count
      FROM webhook_deliveries WHERE operation_group_id=?`)
      .bind(f.operationGroupId)
      .first<{ id: string; operation_group_id: string; event_count: number }>();
    expect(groupedDelivery).toMatchObject({ operation_group_id: f.operationGroupId, event_count: 2 });

    const groupedRefs = await f.DB.prepare(`SELECT ordinal FROM webhook_delivery_events
      WHERE delivery_id=? ORDER BY ordinal`).bind(groupedDelivery!.id).all<{ ordinal: number }>();
    expect(groupedRefs.results.map((row) => row.ordinal)).toEqual([0, 1]);

    const webhookFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", webhookFetch);
    expect(await processOne(f.bindings, f.queued[0]!)).toEqual({ acked: true, retried: false });
    expect(webhookFetch).toHaveBeenCalledTimes(1);

    const groupedRequest = webhookFetch.mock.calls[0]![1] as RequestInit;
    const groupedHeaders = new Headers(groupedRequest.headers);
    const groupedBody = JSON.parse(String(groupedRequest.body)) as { events: Array<{ modelKey: string }> };
    expect(groupedBody.events.map((event) => event.modelKey)).toEqual(["event", "task"]);
    expect(groupedHeaders.get("x-lifespace-operation-group-id")).toBe(f.operationGroupId);
    expect(groupedHeaders.get("x-lifespace-event-count")).toBe("2");
    expect(groupedHeaders.get("x-lifespace-event-id")).toBeNull();
    expect(groupedHeaders.get("x-lifespace-subscription-id")).toBeNull();

    f.queued.length = 0;
    webhookFetch.mockClear();

    const almostSameTime = "2026-09-23T10:01:00.000Z";
    await f.insertEvent({
      eventId: `evt_independent_1_${crypto.randomUUID().replaceAll("-", "")}`,
      modelKey: "task",
      recordId: `rec_independent_1_${crypto.randomUUID().replaceAll("-", "")}`,
      occurredAt: almostSameTime,
    });
    await f.insertEvent({
      eventId: `evt_independent_2_${crypto.randomUUID().replaceAll("-", "")}`,
      modelKey: "task",
      recordId: `rec_independent_2_${crypto.randomUUID().replaceAll("-", "")}`,
      occurredAt: "2026-09-23T10:01:00.001Z",
    });

    expect(await dispatchPendingDomainEvents(f.bindings)).toBe(2);
    expect(f.queued).toHaveLength(2);

    for (const queued of f.queued) {
      expect(await processOne(f.bindings, queued)).toEqual({ acked: true, retried: false });
    }
    expect(webhookFetch).toHaveBeenCalledTimes(2);
    for (const call of webhookFetch.mock.calls) {
      const request = call[1] as RequestInit;
      const headers = new Headers(request.headers);
      const body = JSON.parse(String(request.body)) as { id: string; modelKey: string; events?: unknown };
      expect(body.events).toBeUndefined();
      expect(body.modelKey).toBe("task");
      expect(headers.get("x-lifespace-event-id")).toMatch(/^evt_/u);
      expect(headers.get("x-lifespace-subscription-id")).toMatch(/^sub_/u);
      expect(headers.get("x-lifespace-event-count")).toBe("1");
      expect(headers.get("x-lifespace-operation-group-id")).toBeNull();
    }
  });
});
