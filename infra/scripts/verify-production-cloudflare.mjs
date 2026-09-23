import { readFile } from "node:fs/promises";
import { queueAttachmentSnapshot } from "./production-cloudflare-shapes.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

const manifest = JSON.parse(await readFile(new URL("../production/resources.json", import.meta.url), "utf8"));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cf(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`GET ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result;
}

const databases = await cf(`/accounts/${accountId}/d1/database?per_page=1000`);
const productionD1 = new Map();
for (const desired of manifest.d1 ?? []) {
  const matches = (databases ?? []).filter((item) => item.name === desired.name);
  if (matches.length !== 1 || !matches[0].uuid) throw new Error(`Expected exactly one production D1 database named ${desired.name}`);
  productionD1.set(desired.name, matches[0].uuid);
}
for (const [productionName, stagingName] of [["lifespace-core", "lifespace-core-staging"], ["lifespace-identity", "lifespace-identity-staging"]]) {
  const production = (databases ?? []).find((item) => item.name === productionName);
  const staging = (databases ?? []).find((item) => item.name === stagingName);
  if (production && staging && production.uuid === staging.uuid) throw new Error(`${productionName} unexpectedly reuses staging D1 ${stagingName}`);
}

const r2Result = await cf(`/accounts/${accountId}/r2/buckets?per_page=1000`);
const buckets = Array.isArray(r2Result) ? r2Result : (r2Result?.buckets ?? []);
for (const desired of manifest.r2 ?? []) {
  if (!buckets.some((item) => item.name === desired.name)) throw new Error(`Production R2 bucket ${desired.name} is missing`);
}
if (manifest.r2?.some((item) => item.name === "lifespace-staging-assets")) throw new Error("Production manifest references the staging R2 bucket");

function workerName(consumer) {
  return consumer?.script ?? consumer?.service ?? consumer?.script_name ?? null;
}

// Queue producer/consumer metadata can converge a few seconds after a successful
// Worker deployment. Normal runtime queues must be attached to Core as producer
// and consumer. A DLQ is intentionally only a dead-letter target, so it must
// exist but must not be treated as a normal producer/consumer queue.
const verifiedQueues = new Map();
for (const desired of manifest.queues ?? []) {
  let lastObserved = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const queues = await cf(`/accounts/${accountId}/queues`);
    const queue = (queues ?? []).find((item) => item.queue_name === desired.name);
    if (!queue?.queue_id) throw new Error(`Production Queue ${desired.name} is missing`);

    if (desired.name === "lifespace-event-deliveries-dlq") {
      verifiedQueues.set(desired.name, queue);
      break;
    }

    const endpointConsumers = await cf(`/accounts/${accountId}/queues/${queue.queue_id}/consumers`);
    const snapshot = queueAttachmentSnapshot(queue, endpointConsumers, "lifespace-core");
    lastObserved = { attempt, queueId: queue.queue_id, ...snapshot.observed };
    if (snapshot.consumerAttached && snapshot.producerAttached) {
      if (desired.name === "lifespace-event-deliveries") {
        const consumers = [
          ...(Array.isArray(queue?.consumers) ? queue.consumers : []),
          ...(Array.isArray(endpointConsumers) ? endpointConsumers : []),
        ];
        const eventConsumer = consumers.find((consumer) => consumer?.type === "worker" && workerName(consumer) === "lifespace-core");
        if (!eventConsumer) throw new Error("Production event-delivery Queue is missing the Core worker consumer");
        if (eventConsumer.dead_letter_queue !== "lifespace-event-deliveries-dlq") {
          throw new Error(`Production event-delivery Queue DLQ mismatch: ${eventConsumer.dead_letter_queue ?? "none"}`);
        }
        if (Number(eventConsumer.settings?.max_retries) !== 5) {
          throw new Error(`Production event-delivery Queue max_retries must be 5, got ${eventConsumer.settings?.max_retries ?? "missing"}`);
        }
      }
      verifiedQueues.set(desired.name, queue);
      break;
    }
    if (attempt < 8) await sleep(3000);
  }
  if (!verifiedQueues.has(desired.name)) {
    throw new Error(`Production Queue ${desired.name} producer/consumer attachments did not converge: ${JSON.stringify(lastObserved)}`);
  }
}

const queues = await cf(`/accounts/${accountId}/queues`);
const queueByName = new Map((queues ?? []).map((item) => [item.queue_name, item]));
const productionQueue = queueByName.get("lifespace-creation-drafts");
const stagingQueue = queueByName.get("lifespace-staging-creation-drafts");
if (productionQueue && stagingQueue && productionQueue.queue_id === stagingQueue.queue_id) {
  throw new Error("Production creation-draft Queue unexpectedly reuses staging Queue ID");
}
for (const [productionName, stagingName] of [
  ["lifespace-event-deliveries", "lifespace-staging-event-deliveries"],
  ["lifespace-event-deliveries-dlq", "lifespace-staging-event-deliveries-dlq"],
]) {
  const production = queueByName.get(productionName);
  const staging = queueByName.get(stagingName);
  if (production && staging && production.queue_id === staging.queue_id) {
    throw new Error(`${productionName} unexpectedly reuses staging Queue ${stagingName}`);
  }
}

const workers = await cf(`/accounts/${accountId}/workers/scripts`);
const workerNames = new Set((workers ?? []).map((item) => typeof item === "string" ? item : (item.id ?? item.name ?? item.script_name)).filter(Boolean));
for (const worker of ["lifespace-core", "lifespace-identity"]) {
  if (!workerNames.has(worker)) throw new Error(`Production Worker ${worker} is missing`);
}

async function workerSettings(worker) {
  const settings = await cf(`/accounts/${accountId}/workers/scripts/${worker}/settings`);
  if (!Array.isArray(settings?.bindings)) throw new Error(`Production Worker ${worker} settings did not expose bindings`);
  return settings;
}

function requireSmartPlacement(settings, worker) {
  const placement = settings?.placement;
  const mode = placement?.mode ?? settings?.placement_mode ?? null;
  const status = placement?.status ?? settings?.placement_status ?? null;
  const lastAnalyzedAt = placement?.last_analyzed_at ?? null;
  if (mode !== "smart") throw new Error(`Production Worker ${worker} must enable Smart Placement, got ${mode ?? "missing"}`);
  if (status === "UNSUPPORTED_APPLICATION") {
    throw new Error(`Production Worker ${worker} Smart Placement is unsupported for the current workload`);
  }
  return { mode, status, lastAnalyzedAt };
}

function requireBinding(bindings, expected, worker) {
  const binding = bindings.find((item) => item.name === expected.name && item.type === expected.type);
  if (!binding) throw new Error(`${worker} is missing ${expected.type} binding ${expected.name}`);
  for (const [key, value] of Object.entries(expected.fields ?? {})) {
    if (binding[key] !== value) {
      throw new Error(`${worker} binding ${expected.name}.${key} expected ${value}, got ${binding[key]}`);
    }
  }
}

const coreSettings = await workerSettings("lifespace-core");
const identitySettings = await workerSettings("lifespace-identity");
const placement = {
  core: requireSmartPlacement(coreSettings, "lifespace-core"),
  identity: requireSmartPlacement(identitySettings, "lifespace-identity"),
};

const coreBindings = coreSettings.bindings;
requireBinding(coreBindings, { name: "DB", type: "d1", fields: { database_id: productionD1.get("lifespace-core") } }, "lifespace-core");
requireBinding(coreBindings, { name: "ASSETS", type: "r2_bucket", fields: { bucket_name: "lifespace-assets" } }, "lifespace-core");
requireBinding(coreBindings, { name: "IDENTITY", type: "service", fields: { service: "lifespace-identity" } }, "lifespace-core");
requireBinding(coreBindings, { name: "CREATION_DRAFT_QUEUE", type: "queue", fields: { queue_name: "lifespace-creation-drafts" } }, "lifespace-core");
requireBinding(coreBindings, { name: "EVENT_DELIVERY_QUEUE", type: "queue", fields: { queue_name: "lifespace-event-deliveries" } }, "lifespace-core");

const identityBindings = identitySettings.bindings;
requireBinding(identityBindings, { name: "DB", type: "d1", fields: { database_id: productionD1.get("lifespace-identity") } }, "lifespace-identity");
requireBinding(identityBindings, { name: "ASSETS", type: "r2_bucket", fields: { bucket_name: "lifespace-assets" } }, "lifespace-identity");

const domains = await cf(`/accounts/${accountId}/workers/domains`);
for (const desired of manifest.domains ?? []) {
  const current = (domains ?? []).find((item) => item.hostname === desired.hostname);
  if (!current || current.service !== desired.service) {
    throw new Error(`Production custom domain ${desired.hostname} is not attached to ${desired.service}`);
  }
}

async function secretNames(worker) {
  const result = await cf(`/accounts/${accountId}/workers/scripts/${worker}/secrets`);
  return new Set((result ?? []).map((entry) => entry.name));
}
const identitySecrets = await secretNames("lifespace-identity");
const coreSecrets = await secretNames("lifespace-core");
for (const name of ["BOOTSTRAP_SECRET", "TOKEN_PRIVATE_KEY", "TOKEN_PUBLIC_KEY", "CORE_IDENTITY_SHARED_SECRET"]) {
  if (!identitySecrets.has(name)) throw new Error(`Identity production secret ${name} is missing`);
}
for (const name of ["IDENTITY_PUBLIC_KEY", "CORE_IDENTITY_SHARED_SECRET"]) {
  if (!coreSecrets.has(name)) throw new Error(`Core production secret ${name} is missing`);
}

console.log(JSON.stringify({
  ok: true,
  d1: Object.fromEntries(productionD1),
  r2: manifest.r2?.map((item) => item.name) ?? [],
  queues: manifest.queues?.map((item) => item.name) ?? [],
  queueAttachmentsVerified: true,
  eventDeliveryPolicyVerified: true,
  workers: ["lifespace-core", "lifespace-identity"],
  deployedBindingsVerified: {
    core: ["DB", "ASSETS", "IDENTITY", "CREATION_DRAFT_QUEUE", "EVENT_DELIVERY_QUEUE"],
    identity: ["DB", "ASSETS"],
  },
  smartPlacementVerified: placement,
  domains: Object.fromEntries((manifest.domains ?? []).map((item) => [item.hostname, item.service])),
  secretNamesVerified: true,
  stagingIsolationVerified: true,
}, null, 2));
