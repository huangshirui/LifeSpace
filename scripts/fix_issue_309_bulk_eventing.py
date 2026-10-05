from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import json

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    text = file.read_text()
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {text.count(old)}')
    file.write_text(text.replace(old, new, 1))


def replace_all(path: str, old: str, new: str, minimum: int = 1) -> None:
    file = ROOT / path
    text = file.read_text()
    count = text.count(old)
    if count < minimum:
        raise SystemExit(f'{path}: expected at least {minimum} matches, found {count}')
    file.write_text(text.replace(old, new))


eventing_path = ROOT / 'apps/core/src/eventing.ts'
eventing = eventing_path.read_text()

old_union = '''  | {
      kind: "webhook-delivery-batch";
      deliveryIds: string[];
      changeSetId: string;
      endpointId: string;
    };'''
new_union = '''  | {
      kind: "webhook-delivery-batch";
      deliveryIds: string[];
      changeSetId: string;
      endpointId: string;
    }
  | {
      kind: "webhook-delivery-bulk";
      deliveryIds: string[];
      bulkId: string;
      endpointId: string;
    };'''
if eventing.count(old_union) != 1:
    raise SystemExit('eventing queue union marker drifted')
eventing = eventing.replace(old_union, new_union, 1)

old_row = '''  change_id: string | null;
  change_set_id: string | null;
  occurred_at: string;'''
new_row = '''  change_id: string | null;
  change_set_id: string | null;
  bulk_id: string | null;
  occurred_at: string;'''
if eventing.count(old_row) != 1:
    raise SystemExit('OutboxRow marker drifted')
eventing = eventing.replace(old_row, new_row, 1)

# Every outbox read used by delivery must carry Bulk correlation too.
eventing = eventing.replace('change_id,change_set_id,occurred_at', 'change_id,change_set_id,bulk_id,occurred_at')
eventing = eventing.replace('change_id,change_set_id,occurred_at\n', 'change_id,change_set_id,bulk_id,occurred_at\n')

# Reuse the existing set-wise endpoint/subscription materialization for Bulk.
start = eventing.index('async function dispatchChangeSet(')
end = eventing.index('\nfunction outboxSelect()', start)
dispatch_change_set = eventing[start:end]
dispatch_bulk = dispatch_change_set
for old, new in [
    ('dispatchChangeSet', 'dispatchBulk'),
    ('changeSetId', 'bulkId'),
    ('change_set_id', 'bulk_id'),
    ('Batch Eventing requires one coherent ChangeSet', 'Bulk Eventing requires one coherent Bulk identity'),
    ('kind: "webhook-delivery-batch"', 'kind: "webhook-delivery-bulk"'),
]:
    dispatch_bulk = dispatch_bulk.replace(old, new)
eventing = eventing[:end] + '\n\n' + dispatch_bulk + eventing[end:]

# Expand a selected page to the complete explicit Bulk, just as ChangeSet does.
start = eventing.index('async function expandSelectedChangeSets(')
end = eventing.index('\nasync function markDispatchFailure(', start)
expand_change_sets = eventing[start:end]
expand_bulks = expand_change_sets
for old, new in [
    ('expandSelectedChangeSets', 'expandSelectedBulks'),
    ('changeSetIds', 'bulkIds'),
    ('change_set_id', 'bulk_id'),
]:
    expand_bulks = expand_bulks.replace(old, new)
eventing = eventing[:end] + '\n\n' + expand_bulks + eventing[end:]

old_dispatch_pending = '''  const rows = await expandSelectedChangeSets(env, selected.results);

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
  return dispatched;'''
new_dispatch_pending = '''  const withChangeSets = await expandSelectedChangeSets(env, selected.results);
  const rows = await expandSelectedBulks(env, withChangeSets);

  const singles: OutboxRow[] = [];
  const changeSetGroups = new Map<string, OutboxRow[]>();
  const bulkGroups = new Map<string, OutboxRow[]>();
  for (const event of rows) {
    if (event.change_set_id) {
      const group = changeSetGroups.get(event.change_set_id) ?? [];
      group.push(event);
      changeSetGroups.set(event.change_set_id, group);
      continue;
    }
    if (event.bulk_id) {
      const group = bulkGroups.get(event.bulk_id) ?? [];
      group.push(event);
      bulkGroups.set(event.bulk_id, group);
      continue;
    }
    singles.push(event);
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
  for (const events of changeSetGroups.values()) {
    try {
      await dispatchChangeSet(env, events);
      dispatched += events.length;
    } catch (error) {
      await markDispatchFailure(env, events, error);
    }
  }
  for (const events of bulkGroups.values()) {
    try {
      await dispatchBulk(env, events);
      dispatched += events.length;
    } catch (error) {
      await markDispatchFailure(env, events, error);
    }
  }
  return dispatched;'''
if eventing.count(old_dispatch_pending) != 1:
    raise SystemExit('dispatchPendingDomainEvents marker drifted')
eventing = eventing.replace(old_dispatch_pending, new_dispatch_pending, 1)

eventing = eventing.replace(
    '    changeSetId: events[0]?.change_set_id ?? null,\n    error: message,',
    '    changeSetId: events[0]?.change_set_id ?? null,\n    bulkId: events[0]?.bulk_id ?? null,\n    error: message,',
    1,
)

# Keep the existing proven ChangeSet queue consumer and add a Bulk sibling with
# identical send-time revocation checks, changing only correlation evidence and envelope.
start = eventing.index('async function deliverBatch(')
end = eventing.index('\nexport async function processWebhookDeliveryQueue(', start)
deliver_batch = eventing[start:end]
deliver_bulk = deliver_batch
for old, new in [
    ('deliverBatch', 'deliverBulk'),
    ('{ kind: "webhook-delivery-batch" }', '{ kind: "webhook-delivery-bulk" }'),
    ('message.changeSetId', 'message.bulkId'),
    ('change_set_id', 'bulk_id'),
    ('batch ChangeSet evidence unavailable', 'bulk evidence unavailable'),
    ('type: "change_set.committed",\n    changeSetId: message.bulkId,', 'type: "bulk.completed",\n    bulkId: message.bulkId,'),
    ('"x-lifespace-change-set-id": message.bulkId', '"x-lifespace-bulk-id": message.bulkId'),
]:
    deliver_bulk = deliver_bulk.replace(old, new)
eventing = eventing[:end] + '\n\n' + deliver_bulk + eventing[end:]

old_queue_branch = '''    } else if (
      body.kind === "webhook-delivery-batch"
      && Array.isArray(body.deliveryIds)
      && body.deliveryIds.every((value) => typeof value === "string")
      && typeof body.changeSetId === "string"
      && typeof body.endpointId === "string"
    ) {
      result = await deliverBatch(env, body);
    } else {'''
new_queue_branch = '''    } else if (
      body.kind === "webhook-delivery-batch"
      && Array.isArray(body.deliveryIds)
      && body.deliveryIds.every((value) => typeof value === "string")
      && typeof body.changeSetId === "string"
      && typeof body.endpointId === "string"
    ) {
      result = await deliverBatch(env, body);
    } else if (
      body.kind === "webhook-delivery-bulk"
      && Array.isArray(body.deliveryIds)
      && body.deliveryIds.every((value) => typeof value === "string")
      && typeof body.bulkId === "string"
      && typeof body.endpointId === "string"
    ) {
      result = await deliverBulk(env, body);
    } else {'''
if eventing.count(old_queue_branch) != 1:
    raise SystemExit('queue consumer branch marker drifted')
eventing = eventing.replace(old_queue_branch, new_queue_branch, 1)

eventing_path.write_text(eventing)

# Public Eventing representation changes independently from Kernel: 0.3 -> 0.4.
contract_path = ROOT / 'apps/core/integration-eventing.openapi.yaml'
contract = json.loads(contract_path.read_text())
contract['info']['version'] = '0.4.0'
contract['info']['description'] = (
    'Independently versioned LifeSpace Integration/Eventing contract for Webhook endpoint configuration, '
    'model/event subscriptions, delivery diagnostics, test sends, reference-only signed ordinary-record Webhooks, '
    'explicit ChangeSet batch Webhook envelopes, and explicit non-atomic Bulk Webhook envelopes. Eventing remains '
    'implemented by LifeSpace Core and derives from authoritative ordinary-model Change/event facts; this contract '
    'does not create a second mutation or authorization source.'
)
change_webhook = contract['webhooks']['changeSetCommitted']
bulk_webhook = deepcopy(change_webhook)
bulk_webhook['post']['summary'] = 'Reference-only explicit non-atomic Bulk delivery'
bulk_webhook['post']['description'] = (
    'At-least-once outbound Webhook delivery for one explicit non-atomic Runtime Bulk. The envelope contains only '
    'Bulk identity plus the same reference-only committed Domain Event items used by recordChange; failed Bulk items '
    'produce no Domain Event and are therefore absent. LifeSpace does not time-window coalesce unrelated changes. '
    'Delivery rechecks endpoint/subscription state, managing Application × Model Access, subscriber Data Grant, and '
    'subscriber Service Principal/application eligibility immediately before the outbound attempt.'
)
for parameter in bulk_webhook['post']['parameters']:
    if parameter.get('name') == 'X-LifeSpace-Change-Set-Id':
        parameter['name'] = 'X-LifeSpace-Bulk-Id'
        parameter['description'] = 'Stable explicit non-atomic Bulk correlation identity.'
        parameter['schema']['pattern'] = '^blk_[A-Za-z0-9_-]+$'
bulk_webhook['post']['requestBody']['content']['application/json']['schema']['$ref'] = '#/components/schemas/BulkReferencePayload'
bulk_webhook['post']['responses']['2XX']['description'] = 'Receiver accepted the Bulk delivery. Non-2xx responses are retryable according to LifeSpace Queue delivery policy.'
contract['webhooks']['bulkCompleted'] = bulk_webhook

change_payload = contract['components']['schemas']['ChangeSetReferencePayload']
bulk_payload = deepcopy(change_payload)
bulk_payload['required'] = ['id', 'type', 'bulkId', 'spaceId', 'events', 'occurredAt']
bulk_payload['properties']['type'] = {'type': 'string', 'const': 'bulk.completed'}
bulk_payload['properties']['bulkId'] = bulk_payload['properties'].pop('changeSetId')
bulk_payload['properties']['bulkId']['pattern'] = '^blk_[A-Za-z0-9_-]+$'
contract['components']['schemas']['BulkReferencePayload'] = bulk_payload

semantics = contract['x-lifespace-delivery-semantics']
semantics['bulkIdempotencyHeaders'] = ['X-LifeSpace-Bulk-Id', 'X-LifeSpace-Delivery-Id']
semantics['explicitBatchAggregation'] = (
    'one explicit ChangeSet or Bulk -> one callback envelope per eligible Webhook Endpoint; unrelated changes are never time-window coalesced'
)
contract_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + '\n')

check_path = ROOT / 'apps/core/scripts/check-integration-eventing-openapi.mjs'
check = check_path.read_text()
check = check.replace('document.info?.version !== "0.3.0"', 'document.info?.version !== "0.4.0"')
check = check.replace(
    'const changeSetWebhook = document.webhooks?.changeSetCommitted?.post;\nconst testWebhook = document.webhooks?.endpointTest?.post;\nif (!recordWebhook || !changeSetWebhook || !testWebhook) throw new Error("Outbound Webhook contracts are missing");',
    'const changeSetWebhook = document.webhooks?.changeSetCommitted?.post;\nconst bulkWebhook = document.webhooks?.bulkCompleted?.post;\nconst testWebhook = document.webhooks?.endpointTest?.post;\nif (!recordWebhook || !changeSetWebhook || !bulkWebhook || !testWebhook) throw new Error("Outbound Webhook contracts are missing");',
)
needle = '''if (changeSetWebhook.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ChangeSetReferencePayload") {
  throw new Error("changeSetCommitted Webhook must use the canonical ChangeSet reference payload");
}'''
addition = needle + '''
const bulkPayload = schemas.BulkReferencePayload;
const expectedBulkFields = ["id", "type", "bulkId", "spaceId", "events", "occurredAt"].sort();
if (bulkPayload?.additionalProperties !== false
    || bulkPayload?.properties?.type?.const !== "bulk.completed"
    || bulkPayload?.properties?.events?.maxItems !== 20
    || bulkPayload?.properties?.events?.items?.$ref !== "#/components/schemas/DomainEventReferencePayload"
    || JSON.stringify([...(bulkPayload?.required ?? [])].sort()) !== JSON.stringify(expectedBulkFields)
    || JSON.stringify(Object.keys(bulkPayload?.properties ?? {}).sort()) !== JSON.stringify(expectedBulkFields)) {
  throw new Error("Bulk Webhook must remain a bounded reference-only event envelope");
}
if (bulkWebhook.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/BulkReferencePayload") {
  throw new Error("bulkCompleted Webhook must use the canonical Bulk reference payload");
}'''
if check.count(needle) != 1:
    raise SystemExit('eventing OpenAPI check ChangeSet marker drifted')
check = check.replace(needle, addition, 1)
check = check.replace('for (const operation of [recordWebhook, changeSetWebhook, testWebhook]) {', 'for (const operation of [recordWebhook, changeSetWebhook, bulkWebhook, testWebhook]) {')
needle = '''if (header(changeSetWebhook, "X-LifeSpace-Event-Id")) {
  throw new Error("ChangeSet Webhook must not pretend one event is the batch idempotency key");
}'''
addition = needle + '''
for (const name of ["X-LifeSpace-Bulk-Id", "X-LifeSpace-Delivery-Id", "X-LifeSpace-Webhook-Endpoint-Id"]) {
  if (header(bulkWebhook, name)?.required !== true) throw new Error(`bulkCompleted Webhook missing required ${name}`);
}
if (header(bulkWebhook, "X-LifeSpace-Event-Id")) {
  throw new Error("Bulk Webhook must not pretend one event is the Bulk idempotency key");
}'''
if check.count(needle) != 1:
    raise SystemExit('eventing OpenAPI header marker drifted')
check = check.replace(needle, addition, 1)
check = check.replace(
    '|| JSON.stringify(semantics?.changeSetIdempotencyHeaders) !== JSON.stringify(["X-LifeSpace-Change-Set-Id", "X-LifeSpace-Delivery-Id"])',
    '|| JSON.stringify(semantics?.changeSetIdempotencyHeaders) !== JSON.stringify(["X-LifeSpace-Change-Set-Id", "X-LifeSpace-Delivery-Id"])\n    || JSON.stringify(semantics?.bulkIdempotencyHeaders) !== JSON.stringify(["X-LifeSpace-Bulk-Id", "X-LifeSpace-Delivery-Id"])',
)
check_path.write_text(check)

replace_once('apps/core/AGENTS.md', 'current Integration/Eventing version: 0.3.0', 'current Integration/Eventing version: 0.4.0')
replace_once('docs/eventing.md', 'Integration/Eventing `0.3.0`', 'Integration/Eventing `0.4.0`')
replace_once(
    'docs/contracts.md',
    'Eventing consumers pin `Integration/Eventing 0.3.0` independently',
    'Eventing consumers pin `Integration/Eventing 0.4.0` independently',
)

replace_once(
    'docs/eventing.md',
    'Batch delivery re-runs the same send-time endpoint/subscription, Application × Model Access, subscriber Data Grant and Service Principal eligibility checks before the outbound request. Aggregation therefore changes transport fan-out, not authority or individual Change/Event evidence.',
    'Batch delivery re-runs the same send-time endpoint/subscription, Application × Model Access, subscriber Data Grant and Service Principal eligibility checks before the outbound request. Aggregation therefore changes transport fan-out, not authority or individual Change/Event evidence.\n\nAn explicit non-atomic Bulk uses the same transport aggregation rule without pretending to be a ChangeSet. Successful events sharing one `bulkId` are grouped by Webhook Endpoint and sent as one signed `bulk.completed` callback containing `1..20` reference-only `events[]`; failed Bulk items produce no committed Change/Event and are absent from that envelope. The callback uses `X-LifeSpace-Bulk-Id` plus `X-LifeSpace-Delivery-Id` as its idempotency identity. Unrelated operations are never time-window coalesced.',
)

# Focused integration acceptance: a Bulk remains per-event evidence internally but is
# exactly one outbound callback for one eligible endpoint.
test_path = ROOT / 'apps/core/test/bulk-eventing.integration.test.ts'
test_path.write_text(r'''import { env } from "cloudflare:workers";
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
      return Response.json({ data: { active: true, displayName: "Bulk subscriber" } });
    },
  } as unknown as Fetcher;
}

describe("Bulk Eventing aggregation", () => {
  it("keeps per-event delivery evidence but sends one bulk.completed callback per endpoint", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    const spaceId = `spc_${suffix}`;
    const userId = `usr_${suffix}`;
    const applicationId = `app_${suffix}`;
    const subscriberId = `svc_${suffix}`;
    const endpointId = `wep_${suffix}`;
    const subscriptionId = `sub_${suffix}`;
    const bulkId = `blk_${suffix}`;

    const setup = [
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(spaceId, "Bulk Eventing", userId, now, now, "UTC"),
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
        endpointId, applicationId, spaceId, subscriberId, "Bulk endpoint",
        "https://automation.example.com/hooks/bulk", "b".repeat(64), userId, now, now,
      ),
      db.prepare(`INSERT INTO event_subscriptions(
        id,endpoint_id,model_key,include_created,include_updated,include_deleted,enabled,
        created_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,1,0,0,1,?,?,?)`).bind(
        subscriptionId, endpointId, "task", userId, now, now,
      ),
    ];
    for (let index = 0; index < 20; index += 1) {
      setup.push(db.prepare(`INSERT INTO domain_event_outbox(
        id,event_type,space_id,model_key,record_id,record_version,change_id,change_set_id,bulk_id,
        actor_type,actor_id,occurred_at
      ) VALUES(?,'record.created',?,?,?,1,?,NULL,?, 'user',?,?)`).bind(
        `evt_${suffix}_${index}`,
        spaceId,
        "task",
        `rec_${suffix}_${index}`,
        `chg_${suffix}_${index}`,
        bulkId,
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

    expect(await dispatchPendingDomainEvents(bindings)).toBe(20);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "webhook-delivery-bulk", bulkId, endpointId });
    if (queued[0]?.kind !== "webhook-delivery-bulk") throw new Error("Expected Bulk delivery");
    expect(queued[0].deliveryIds).toHaveLength(20);

    const webhookFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.type).toBe("bulk.completed");
      expect(payload.bulkId).toBe(bulkId);
      expect(payload.events).toHaveLength(20);
      expect(new Set(payload.events.map((event: any) => event.id)).size).toBe(20);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-lifespace-bulk-id")).toBe(bulkId);
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
    expect(deliveries.results).toHaveLength(20);
    expect(deliveries.results.every((row) => row.status === "succeeded" && row.attempt_count === 1)).toBe(true);
  });
});
''')

print('Applied #309 Bulk Eventing aggregation fix')
