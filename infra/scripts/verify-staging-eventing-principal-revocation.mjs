import process from "node:process";

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

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_SMOKE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: applicationSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
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

async function expectStatus(label, result, expectedStatus, expectedCode = null) {
  if (result.response.status !== expectedStatus || (expectedCode && result.payload?.error?.code !== expectedCode)) {
    throw new Error(`${label}: expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
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
  const detail = last?.response ? `${last.response.status} ${JSON.stringify(last.payload)}` : String(last?.error ?? "no result");
  throw new Error(`${label} did not converge: ${detail}`);
}

let managerBearer = "";
let subscriberPrincipalId = "";
let grantId = "";
let grantActive = false;
let endpointId = "";
let subscriptionId = "";
let eventId = "";
let eventVersion = 0;
let principalDisabled = false;
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
  const tokenData = await expectStatus("staging Eventing revocation manager token", tokenResult, 200);
  managerBearer = tokenData?.accessToken ?? "";
  if (!managerBearer) throw new Error("Staging Eventing revocation manager token was not returned");
  mask(managerBearer);

  const principal = await request(identityBase, "/api/v1/service-principals", {
    method: "POST",
    bearer: applicationSecret,
    body: {
      displayName: `Staging Disabled Eventing Subscriber ${suffix}`.slice(0, 100),
      description: "Ephemeral staging-only subscriber used to prove Identity disablement blocks Eventing independently of Grant cleanup",
      maxScopes: ["resources:read"],
      createdByUserId: userId,
    },
  });
  const principalData = await expectStatus("staging disabled Eventing subscriber principal", principal, 201);
  subscriberPrincipalId = principalData?.id ?? "";
  if (!subscriberPrincipalId) throw new Error("Staging disabled Eventing subscriber principal ID was not returned");

  const endpoint = await request(coreBase, "/api/v1/webhook-endpoints", {
    method: "POST",
    bearer: managerBearer,
    body: {
      spaceId,
      subscriberServicePrincipalId: subscriberPrincipalId,
      name: `Staging Disabled Subscriber ${suffix}`.slice(0, 80),
      webhookUrl: "https://disabled-subscriber.invalid/webhook",
    },
  });
  const endpointData = await expectStatus("staging disabled-subscriber Webhook Endpoint", endpoint, 201);
  endpointId = endpointData?.id ?? "";
  if (!endpointId) throw new Error("Staging disabled-subscriber Webhook Endpoint ID was not returned");

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
  const grantData = await expectStatus("staging disabled-subscriber Data Grant", grant, 201);
  grantId = grantData?.id ?? "";
  if (!grantId) throw new Error("Staging disabled-subscriber Data Grant ID was not returned");
  grantActive = true;

  const subscription = await request(coreBase, "/api/v1/event-subscriptions", {
    method: "POST",
    bearer: managerBearer,
    body: {
      endpointId,
      modelKey: "event",
      eventTypes: ["record.created"],
    },
  });
  const subscriptionData = await expectStatus("staging disabled-subscriber Event Subscription", subscription, 201);
  subscriptionId = subscriptionData?.id ?? "";
  if (!subscriptionId) throw new Error("Staging disabled-subscriber Event Subscription ID was not returned");

  const disabled = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(subscriberPrincipalId)}`, {
    method: "PATCH",
    bearer: applicationSecret,
    body: { status: "disabled" },
  });
  const disabledData = await expectStatus("staging subscriber principal disable", disabled, 200);
  if (disabledData?.status !== "disabled") throw new Error("Staging subscriber principal did not become disabled");
  principalDisabled = true;

  const grantsAfterDisable = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants`, {
    bearer: managerBearer,
  });
  const currentGrants = await expectStatus("staging Grants after principal disable", grantsAfterDisable, 200);
  const stillActiveGrant = Array.isArray(currentGrants)
    ? currentGrants.find((item) => item?.id === grantId && item?.granteeId === subscriberPrincipalId)
    : null;
  if (!stillActiveGrant || stillActiveGrant.revokedAt !== null) {
    throw new Error("Subscriber Data Grant must remain active while principal-disable Eventing revocation is proved");
  }

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const created = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      summary: `Staging disabled subscriber ${suffix}`,
      when: {
        kind: "instant",
        start: start.toISOString(),
        endExclusive: end.toISOString(),
      },
      attendeePersonIds: [personId],
    },
  });
  const event = await expectStatus("staging Eventing mutation after principal disable", created, 201);
  eventId = event?.id ?? "";
  eventVersion = event?.version ?? 0;
  if (!eventId || !Number.isInteger(eventVersion) || eventVersion < 1) throw new Error("Staging Eventing mutation returned an invalid record");

  const deliveryPoll = await poll(
    "disabled-subscriber Eventing delivery cancellation",
    () => request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries`, { bearer: managerBearer }),
    ({ response, payload }) => response.status === 200 && payload?.data?.items?.some?.((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created" && item.status === "cancelled"),
    { attempts: 50, delayMs: 3000 },
  );
  const delivery = deliveryPoll.payload.data.items.find((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created");
  if (delivery.attemptCount !== 0 || delivery.lastStatusCode != null || delivery.lastError !== "subscriber service principal inactive") {
    throw new Error(`Disabled subscriber delivery crossed the outbound boundary: ${JSON.stringify(delivery)}`);
  }

  const grantsAfterCancellation = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants`, {
    bearer: managerBearer,
  });
  const grantsAfterCancellationData = await expectStatus("staging Grants after delivery cancellation", grantsAfterCancellation, 200);
  const grantAfterCancellation = Array.isArray(grantsAfterCancellationData)
    ? grantsAfterCancellationData.find((item) => item?.id === grantId)
    : null;
  if (!grantAfterCancellation || grantAfterCancellation.revokedAt !== null) {
    throw new Error("Data Grant cleanup occurred before the principal-disable Eventing boundary was proved");
  }

  verification = {
    ok: true,
    subscriberServicePrincipalId: subscriberPrincipalId,
    endpointId,
    subscriptionId,
    disabledPrincipalBlocksQueuedDelivery: true,
    grantRemainedActiveUntilAfterDeliveryCancellation: true,
    outboundAttemptCount: delivery.attemptCount,
    delivery: {
      id: delivery.id,
      eventId: delivery.eventId,
      modelKey: delivery.modelKey,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
    },
    domainEvent: { modelKey: "event", recordId: eventId, version: eventVersion },
    identityStateIsSecurityBoundary: true,
  };
} catch (error) {
  primaryError = error;
} finally {
  async function cleanup(label, action) {
    try { await action(); }
    catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
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
      grantActive = false;
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
  if (subscriberPrincipalId && !principalDisabled) {
    await cleanup("subscriber principal disable", async () => {
      const result = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(subscriberPrincipalId)}`, {
        method: "PATCH",
        bearer: applicationSecret,
        body: { status: "disabled" },
      });
      if (![200, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
}

if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Staging Eventing principal-revocation cleanup failed: ${cleanupErrors.join(" | ")}`);
console.log(JSON.stringify(verification, null, 2));
