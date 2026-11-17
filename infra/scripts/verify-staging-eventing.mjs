import { registerRunnerSecret as mask } from "./runner-secret.mjs";
import process from "node:process";
import { receiverClient } from "./eventing-smoke-receiver-client.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const suffix = `${runId}_${runAttempt}`.replace(/[^0-9A-Za-z]/gu, "").slice(-12).toLowerCase();
const receiver = receiverClient();

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_SMOKE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: applicationSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

async function readResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function request(base, path, { method = "GET", bearer, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await readResponse(response) };
}

async function poll(label, action, predicate, { attempts = 50, delayMs = 3000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const code = last?.error?.cause?.code ?? last?.error?.name;
  const detail = last?.response ? `HTTP ${last.response.status}` : `no response (${/^[A-Za-z0-9_]{1,60}$/u.test(code??"")?code:"unknown"})`;
  throw new Error(`${label} did not converge: ${detail}`);
}

async function expectStatus(label, result, expectedStatus, expectedCode = null) {
  if (result.response.status !== expectedStatus || (expectedCode && result.payload?.error?.code !== expectedCode)) {
    throw new Error(`${label}: expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""}, got ${result.response.status}`);
  }
  return result.payload?.data;
}

let sessionAttempted = false;

let managerBearer = "";
let subscriberPrincipalId = "";
let grantId = "";
let grantActive = false;
let endpointId = "";
let subscriptionId = "";
let eventId = "";
let eventVersion = 0;
let verification = null;
let primaryError = null;
const cleanupErrors = [];

try {
  // Staging smoke creates a short-lived trusted Application with the required
  // scopes. Validate its current authorization and fail closed on drift.
  // Never let an acceptance test widen its own Application scope ceiling.
  const applicationMetadata = await request(identityBase, "/internal/v1/applications/self", {
    bearer: applicationSecret,
  });
  const appData = await expectStatus("staging smoke own application metadata", applicationMetadata, 200);
  if (appData?.id !== applicationId || appData?.trustedBackend !== true || appData?.status !== "active") {
    throw new Error("Staging Eventing Application identity/trust mismatch");
  }
  const requiredScopes = ["spaces:manage", "grants:manage", "resources:read", "resources:write"];
  if (!Array.isArray(appData.allowedScopes) || requiredScopes.some((scope) => !appData.allowedScopes.includes(scope))) {
    throw new Error("Staging Eventing Application missing required scope ceiling; no automatic elevation");
  }

  const tokenResult = await request(identityBase, "/internal/v1/tokens", {
    method: "POST",
    bearer: applicationSecret,
    body: {
      subjectId: userId,
      scopes: ["spaces:manage", "grants:manage", "resources:read", "resources:write"],
    },
  });
  const tokenData = await expectStatus("staging Eventing manager token", tokenResult, 200);
  managerBearer = tokenData?.accessToken ?? "";
  if (!managerBearer) throw new Error("Staging Eventing manager token was not returned");
  mask(managerBearer);

  const principal = await request(identityBase, "/api/v1/service-principals", {
    method: "POST",
    bearer: applicationSecret,
    body: {
      displayName: `Staging Eventing Subscriber ${suffix}`.slice(0, 100),
      description: "Ephemeral staging-only subscriber used by the LifeSpace Eventing smoke test",
      maxScopes: ["resources:read"],
      createdByUserId: userId,
    },
  });
  const principalData = await expectStatus("staging Eventing subscriber principal", principal, 201);
  subscriberPrincipalId = principalData?.id ?? "";
  if (!subscriberPrincipalId) throw new Error("Staging Eventing subscriber principal ID was not returned");

  await receiver.ready();
  const webhookUrl = receiver.url;
  const endpoint = await request(coreBase, "/api/v1/webhook-endpoints", {
    method: "POST",
    bearer: managerBearer,
    body: {
      spaceId,
      subscriberServicePrincipalId: subscriberPrincipalId,
      name: `Staging Eventing ${suffix}`.slice(0, 80),
      webhookUrl,
    },
  });
  const endpointData = await expectStatus("staging Eventing Webhook Endpoint", endpoint, 201);
  endpointId = endpointData?.id ?? "";
  const signingSecret = endpointData?.signingSecret ?? "";
  if (!endpointId || typeof signingSecret !== "string" || signingSecret.length < 64) {
    throw new Error("Staging Eventing Webhook Endpoint did not return the one-time signing secret");
  }
  mask(signingSecret);

  const listedEndpoints = await request(coreBase, `/api/v1/webhook-endpoints?spaceId=${encodeURIComponent(spaceId)}&subscriberServicePrincipalId=${encodeURIComponent(subscriberPrincipalId)}`, {
    bearer: managerBearer,
  });
  const endpointListData = await expectStatus("staging Eventing Webhook Endpoint list", listedEndpoints, 200);
  const listedEndpoint = endpointListData?.items?.find?.((item) => item.id === endpointId);
  if (!listedEndpoint || listedEndpoint.signingSecret !== undefined || listedEndpoint.signingConfigured !== true) {
    throw new Error("Staging Eventing Webhook Endpoint read did not preserve one-time secret semantics");
  }

  const subscriptionBody = {
    endpointId,
    modelKey: "event",
    eventTypes: ["record.created"],
  };
  const denied = await request(coreBase, "/api/v1/event-subscriptions", {
    method: "POST",
    bearer: managerBearer,
    body: subscriptionBody,
  });
  await expectStatus("subscription without subscriber Grant", denied, 403, "EVENT_SUBSCRIBER_ACCESS_DENIED");

  const grant = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      granteeType: "service",
      granteeId: subscriberPrincipalId,
      resourceType: "model",
      resourceId: "event",
      permission: "read",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  });
  const grantData = await expectStatus("staging Eventing subscriber Grant", grant, 201);
  grantId = grantData?.id ?? "";
  if (!grantId) throw new Error("Staging Eventing subscriber Grant ID was not returned");
  grantActive = true;

  const subscription = await request(coreBase, "/api/v1/event-subscriptions", {
    method: "POST",
    bearer: managerBearer,
    body: subscriptionBody,
  });
  const subscriptionData = await expectStatus("staging Eventing subscription filter", subscription, 201);
  subscriptionId = subscriptionData?.id ?? "";
  if (!subscriptionId || subscriptionData?.endpointId !== endpointId || subscriptionData?.modelKey !== "event") {
    throw new Error("Staging Eventing subscription filter did not bind to the shared Webhook Endpoint");
  }

  const listedSubscriptions = await request(coreBase, `/api/v1/event-subscriptions?endpointId=${encodeURIComponent(endpointId)}`, {
    bearer: managerBearer,
  });
  const subscriptionListData = await expectStatus("staging Eventing subscription-filter list", listedSubscriptions, 200);
  if (!subscriptionListData?.items?.some?.((item) => item.id === subscriptionId && item.endpointId === endpointId && item.modelKey === "event")) {
    throw new Error("Staging Eventing subscription filter was not listed under its Webhook Endpoint");
  }

  // Attempt cleanup even if registration response is lost.
  sessionAttempted = true;
  await receiver.create({signingSecret,spaceId,endpointId,subscriptionId,subscriberServicePrincipalId});
  const initialReceipts = await receiver.receipts();
  if (initialReceipts.testCount!==0 || initialReceipts.receipts.length!==0) throw Error("Fresh receiver session is not empty");

  const testSend = await request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/test`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const testData = await expectStatus("signed staging Webhook Endpoint test", testSend, 200);
  if (testData?.ok !== true || testData?.statusCode !== 204) {
    throw new Error(`Staging Webhook Endpoint test sink rejected the signed request (HTTP ${Number.isInteger(testData?.statusCode) ? testData.statusCode : "unknown"})`);
  }

  if ((await receiver.receipts()).testCount!==1) throw Error("Signed endpoint test receipt missing");

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const created = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      summary: `Staging Eventing ${suffix}`,
      when: {
        kind: "instant",
        start: start.toISOString(),
        endExclusive: end.toISOString(),
      },
      attendeePersonIds: [personId],
    },
  });
  const event = await expectStatus("staging Eventing domain mutation", created, 201);
  eventId = event?.id ?? "";
  eventVersion = event?.version ?? 0;
  if (!eventId || !Number.isInteger(eventVersion) || eventVersion < 1) throw new Error("Staging Eventing domain mutation returned an invalid record");

  const deliveryPoll = await poll(
    "real staging Eventing outbox/Queue/shared-Endpoint Webhook delivery",
    () => request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries`, { bearer: managerBearer }),
    ({ response, payload }) => response.status === 200 && payload?.data?.items?.some?.((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created" && item.status === "succeeded" && item.lastStatusCode === 204),
    { attempts: 50, delayMs: 3000 },
  );
  const delivery = deliveryPoll.payload.data.items.find((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created");

  const received = await receiver.receipts();
  const receipt = received.receipts.find(item =>
    item.deliveryId===delivery.id && item.eventId===delivery.eventId && item.recordId===eventId
    && item.recordVersion===eventVersion && item.changeId===delivery.changeId);
  if (!receipt || received.receipts.length!==1 || delivery.recordVersion!==eventVersion) throw Error("Real delivery 204 has no unique matching receiver receipt");

  const revoked = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    bearer: managerBearer,
  });
  await expectStatus("staging Eventing Grant revoke", revoked, 204);
  grantActive = false;

  const deniedAfterRevoke = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    bearer: managerBearer,
    body: { eventTypes: ["record.created", "record.updated"] },
  });
  await expectStatus("subscription filter update after subscriber Grant revoke", deniedAfterRevoke, 403, "EVENT_SUBSCRIBER_ACCESS_DENIED");

  const endpointTestAfterRevoke = await request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/test`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const endpointTestAfterRevokeData = await expectStatus("Webhook Endpoint transport test after model Grant revoke", endpointTestAfterRevoke, 200);
  if (endpointTestAfterRevokeData?.ok !== true || endpointTestAfterRevokeData?.statusCode !== 204) {
    throw new Error("Webhook Endpoint transport/signature test should remain independent from model Data Grant state");
  }

  if ((await receiver.receipts()).testCount!==2) throw Error("Signed post-revocation test receipt missing");

  verification = {
    ok: true,
    receiver: "persistent-staging-https",
    receiverSession: receiver.sessionId,
    subscriberServicePrincipalId: subscriberPrincipalId,
    endpointId,
    subscriptionId,
    endpointOwnsTransportAndSigning: true,
    subscriberGrantRequiredForModelFilter: true,
    signingSecretOneTime: true,
    signedEndpointTestStatusCode: testData.statusCode,
    endpointTransportTestIndependentFromModelGrant: true,
    domainEvent: { modelKey: "event", recordId: eventId, version: eventVersion },
    delivery: { id: delivery.id, eventId: delivery.eventId, modelKey: delivery.modelKey, status: delivery.status, attemptCount: delivery.attemptCount, lastStatusCode: delivery.lastStatusCode },
    realPath: "event mutation -> D1 outbox -> subscription filter -> shared Webhook Endpoint -> Cloudflare Queue -> HMAC Webhook Custom Domain",
    grantRevocationRecheckedOnSubscriptionMutation: true,
    referenceOnlyPayloadValidatedBySink: true,
  };
} catch (error) {
  primaryError = error;
} finally {
  async function cleanup(label, action) {
    try { await action(); }
    catch { cleanupErrors.push(`${label}: failed`); }
  }

  if (subscriptionId && managerBearer) {
    await cleanup("subscription delete", async () => {
      const result = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE", bearer: managerBearer });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (endpointId && managerBearer) {
    await cleanup("Webhook Endpoint delete", async () => {
      const result = await request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`, { method: "DELETE", bearer: managerBearer });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (grantActive && grantId && managerBearer) {
    await cleanup("Grant revoke", async () => {
      const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE", bearer: managerBearer });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (eventId && eventVersion && managerBearer) {
    await cleanup("event delete", async () => {
      const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        bearer: managerBearer,
        body: { version: eventVersion },
      });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (subscriberPrincipalId) {
    await cleanup("subscriber principal disable", async () => {
      const result = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(subscriberPrincipalId)}`, {
        method: "PATCH",
        bearer: applicationSecret,
        body: { status: "disabled" },
      });
      if (![200, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (sessionAttempted) await cleanup("receiver session delete", () => receiver.remove());
}

if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Staging Eventing smoke cleanup failed: ${cleanupErrors.join(" | ")}`);

console.log(JSON.stringify({ ...verification, cleanup: { receiverSessionDeleted: true, subscriberDisabled: true, applicationScopeRestored: true } }, null, 2));
