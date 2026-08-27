import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const suffix = `${runId}_${runAttempt}`.replace(/[^0-9A-Za-z]/gu, "").slice(-12).toLowerCase();
const workerName = `lifespace-eventing-smoke-${suffix}`.slice(0, 63);
const sinkHostname = `eventing-smoke-staging-${suffix}.aisr.online`;
const sinkBase = `https://${sinkHostname}`;

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: apiToken,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_SMOKE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: applicationSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

const sinkSource = String.raw`
const encoder = new TextEncoder();

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function expectedSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + "." + rawBody));
  return "v1=" + hex(new Uint8Array(signed));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}

function bad(message, status = 400) {
  return new Response(message, { status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method === "GET" && url.pathname === "/ready") {
      return env.EVENTING_SIGNING_SECRET ? new Response("ready") : new Response("secret missing", { status: 503 });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
    if (!env.EVENTING_SIGNING_SECRET) return bad("secret missing", 503);

    const timestamp = request.headers.get("x-lifespace-timestamp") || "";
    const supplied = request.headers.get("x-lifespace-signature") || "";
    const timestampNumber = Number(timestamp);
    if (!Number.isInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) {
      return bad("timestamp invalid", 401);
    }

    const rawBody = await request.text();
    const expected = await expectedSignature(env.EVENTING_SIGNING_SECRET, timestamp, rawBody);
    if (!sameText(expected, supplied)) return bad("signature invalid", 401);

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return bad("body invalid"); }

    if (request.headers.get("x-lifespace-test") === "true") {
      if (!exactKeys(payload, ["id", "type", "endpointId", "spaceId", "subscriberServicePrincipalId", "occurredAt"])) return bad("test payload is not reference-only");
      if (payload.type !== "endpoint.test") return bad("test payload semantics invalid");
      if (request.headers.get("x-lifespace-webhook-endpoint-id") !== payload.endpointId) return bad("test endpoint header mismatch");
      return new Response(null, { status: 204 });
    }

    if (!exactKeys(payload, ["id", "type", "spaceId", "modelKey", "recordId", "recordVersion", "occurredAt"])) return bad("domain payload is not reference-only");
    if (payload.type !== "record.created" || payload.modelKey !== "event") return bad("domain payload semantics invalid");
    if (!Number.isInteger(payload.recordVersion) || payload.recordVersion < 1) return bad("record version invalid");
    if (request.headers.get("x-lifespace-event-id") !== payload.id) return bad("event header mismatch");
    if (!request.headers.get("x-lifespace-delivery-id") || !request.headers.get("x-lifespace-webhook-endpoint-id") || !request.headers.get("x-lifespace-subscription-id")) return bad("delivery headers missing");
    return new Response(null, { status: 204 });
  },
};
`;

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

async function readResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function request(base, path, { method = "GET", bearer, bootstrap, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(bootstrap ? { "x-bootstrap-secret": bootstrap } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await readResponse(response) };
}

async function cf(path, { method = "GET", body, form } = {}) {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headers = { Authorization: `Bearer ${apiToken}` };
    let requestBody;
    if (form) requestBody = form;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: requestBody });
    const payload = await readResponse(response);
    if (response.ok && payload?.success !== false) return payload?.result;

    const detail = JSON.stringify(payload?.errors ?? payload);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${detail}`);
    }

    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, 10_000)
      : attempt * 2000;
    console.warn(`Cloudflare ${method} ${path} returned ${response.status}; retrying in ${delayMs}ms (${attempt}/${attempts})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Cloudflare ${method} ${path} retry loop exited unexpectedly`);
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

async function expectStatus(label, result, expectedStatus, expectedCode = null) {
  if (result.response.status !== expectedStatus || (expectedCode && result.payload?.error?.code !== expectedCode)) {
    throw new Error(`${label}: expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

let workerCreated = false;
let customDomainAttached = false;

async function deploySink(signingSecret) {
  const form = new FormData();
  form.set("metadata", new File([
    JSON.stringify({
      main_module: "worker.mjs",
      compatibility_date: "2026-08-08",
      bindings: [{ type: "secret_text", name: "EVENTING_SIGNING_SECRET", text: signingSecret }],
    }),
  ], "metadata.json", { type: "application/json" }));
  form.set("worker.mjs", new File([sinkSource], "worker.mjs", { type: "application/javascript+module" }));
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "PUT", form });
  workerCreated = true;

  const existing = await cf(`/accounts/${accountId}/workers/domains`);
  const current = (existing ?? []).find((item) => item.hostname === sinkHostname);
  if (current && current.service !== workerName) {
    throw new Error(`Staging Eventing smoke hostname ${sinkHostname} is already attached to ${current.service}`);
  }
  if (!current) {
    await cf(`/accounts/${accountId}/workers/domains`, {
      method: "PUT",
      body: { hostname: sinkHostname, service: workerName, zone_name: "aisr.online" },
    });
  }
  customDomainAttached = true;
}

async function detachSinkDomain() {
  const domains = await cf(`/accounts/${accountId}/workers/domains`);
  const current = (domains ?? []).find((item) => item.hostname === sinkHostname && item.service === workerName);
  if (current) {
    await cf(`/accounts/${accountId}/workers/domains/${encodeURIComponent(current.id)}`, { method: "DELETE" });
  }
}

let originalApplicationScopes = null;
let applicationScopesChanged = false;
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
  const applicationMetadata = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
    bootstrap: bootstrapSecret,
  });
  const appData = await expectStatus("staging smoke application metadata", applicationMetadata, 200);
  originalApplicationScopes = Array.isArray(appData?.allowedScopes) ? [...appData.allowedScopes] : null;
  if (!originalApplicationScopes) throw new Error("Staging smoke application scopes are unavailable");
  if (!originalApplicationScopes.includes("grants:manage")) {
    const update = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
      method: "PATCH",
      bootstrap: bootstrapSecret,
      body: { allowedScopes: [...originalApplicationScopes, "grants:manage"] },
    });
    await expectStatus("temporary grants:manage staging scope", update, 200);
    applicationScopesChanged = true;
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

  const webhookUrl = `${sinkBase}/webhook`;
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

  await deploySink(signingSecret);
  await poll(
    "staging Eventing Custom Domain receiver readiness",
    async () => {
      const response = await fetch(`${sinkBase}/ready`);
      return { response, payload: await response.text() };
    },
    ({ response }) => response.status === 200,
    { attempts: 60, delayMs: 2000 },
  );

  const testSend = await request(coreBase, `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/test`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const testData = await expectStatus("signed staging Webhook Endpoint test", testSend, 200);
  if (testData?.ok !== true || testData?.statusCode !== 204) {
    throw new Error(`Staging Webhook Endpoint test sink rejected the signed request: ${JSON.stringify(testData)}`);
  }

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const created = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      summary: `Staging Eventing ${suffix}`,
      isAllDay: false,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      startTimezone: "UTC",
      endTimezone: "UTC",
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

  verification = {
    ok: true,
    worker: workerName,
    customDomain: sinkHostname,
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
    });
  }
  if (eventId && eventVersion && managerBearer) {
    await cleanup("event delete", async () => {
      const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, {
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
  if (applicationScopesChanged && originalApplicationScopes) {
    await cleanup("staging smoke application scope restore", async () => {
      const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
        method: "PATCH",
        bootstrap: bootstrapSecret,
        body: { allowedScopes: originalApplicationScopes },
      });
      if (result.response.status !== 200) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (customDomainAttached) {
    await cleanup("temporary staging Custom Domain detach", detachSinkDomain);
  }
  if (workerCreated) {
    await cleanup("temporary Eventing sink Worker delete", async () => {
      await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "DELETE" });
    });
  }
}

if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Staging Eventing smoke cleanup failed: ${cleanupErrors.join(" | ")}`);

console.log(JSON.stringify({ ...verification, cleanup: { temporaryCustomDomainDetached: true, temporarySinkDeleted: true, subscriberDisabled: true, applicationScopeRestored: true } }, null, 2));
