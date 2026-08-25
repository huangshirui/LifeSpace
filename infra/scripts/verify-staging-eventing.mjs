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
const marker = `${runId}_${runAttempt}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const workerName = `lifespace-eventing-smoke-${runId}-${runAttempt}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 63);

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
      if (!exactKeys(payload, ["id", "type", "subscriptionId", "spaceId", "subscriberServicePrincipalId", "modelKey", "occurredAt"])) return bad("test payload is not reference-only");
      if (payload.type !== "subscription.test" || payload.modelKey !== "event") return bad("test payload semantics invalid");
      if (request.headers.get("x-lifespace-subscription-id") !== payload.subscriptionId) return bad("test subscription header mismatch");
      return new Response(null, { status: 204 });
    }

    if (!exactKeys(payload, ["id", "type", "spaceId", "modelKey", "recordId", "recordVersion", "occurredAt"])) return bad("domain payload is not reference-only");
    if (payload.type !== "record.created" || payload.modelKey !== "event") return bad("domain payload semantics invalid");
    if (!Number.isInteger(payload.recordVersion) || payload.recordVersion < 1) return bad("record version invalid");
    if (request.headers.get("x-lifespace-event-id") !== payload.id) return bad("event header mismatch");
    if (!request.headers.get("x-lifespace-delivery-id") || !request.headers.get("x-lifespace-subscription-id")) return bad("delivery headers missing");
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
  const headers = { Authorization: `Bearer ${apiToken}` };
  let requestBody;
  if (form) requestBody = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: requestBody });
  const payload = await readResponse(response);
  if (!response.ok || payload?.success === false) {
    throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${JSON.stringify(payload?.errors ?? payload)}`);
  }
  return payload;
}

async function deploySink() {
  const form = new FormData();
  form.set("metadata", new File([
    JSON.stringify({ main_module: "worker.mjs", compatibility_date: "2026-08-08" }),
  ], "metadata.json", { type: "application/json" }));
  form.set("worker.mjs", new File([sinkSource], "worker.mjs", { type: "application/javascript+module" }));
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "PUT", form });
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
    method: "POST",
    body: { enabled: true, previews_enabled: false },
  });
  const accountSubdomain = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = accountSubdomain?.result?.subdomain;
  if (typeof subdomain !== "string" || !subdomain) throw new Error("Cloudflare account has no workers.dev subdomain");
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function installSinkSecret(secret) {
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/secrets`, {
    method: "PUT",
    body: { name: "EVENTING_SIGNING_SECRET", text: secret, type: "secret_text" },
  });
}

async function poll(label, action, predicate, { attempts = 36, delayMs = 5000 } = {}) {
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

let sinkBase = "";
let originalApplicationScopes = null;
let applicationScopesChanged = false;
let managerBearer = "";
let subscriberPrincipalId = "";
let grantId = "";
let grantActive = false;
let subscriptionId = "";
let eventId = "";
let eventVersion = 0;
let verification = null;
let primaryError = null;
const cleanupErrors = [];

try {
  sinkBase = await deploySink();
  await poll(
    "staging Eventing smoke sink health",
    async () => {
      const response = await fetch(`${sinkBase}/health`);
      return { response, payload: await response.text() };
    },
    ({ response }) => response.status === 200,
    { attempts: 20, delayMs: 1000 },
  );

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
      displayName: `Staging Eventing Subscriber ${marker}`.slice(0, 100),
      description: "Ephemeral staging-only subscriber used by the LifeSpace Eventing smoke test",
      maxScopes: ["resources:read"],
      createdByUserId: userId,
    },
  });
  const principalData = await expectStatus("staging Eventing subscriber principal", principal, 201);
  subscriberPrincipalId = principalData?.id ?? "";
  if (!subscriberPrincipalId) throw new Error("Staging Eventing subscriber principal ID was not returned");

  const webhookUrl = `${sinkBase}/webhook`;
  const subscriptionBody = {
    spaceId,
    subscriberServicePrincipalId: subscriberPrincipalId,
    name: `Staging Eventing ${marker}`.slice(0, 80),
    modelKey: "event",
    eventTypes: ["record.created"],
    webhookUrl,
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
  const subscriptionData = await expectStatus("staging Eventing subscription", subscription, 201);
  subscriptionId = subscriptionData?.id ?? "";
  const signingSecret = subscriptionData?.signingSecret ?? "";
  if (!subscriptionId || typeof signingSecret !== "string" || signingSecret.length < 64) {
    throw new Error("Staging Eventing subscription did not return the one-time signing secret");
  }
  mask(signingSecret);

  const listed = await request(coreBase, `/api/v1/event-subscriptions?spaceId=${encodeURIComponent(spaceId)}&subscriberServicePrincipalId=${encodeURIComponent(subscriberPrincipalId)}`, {
    bearer: managerBearer,
  });
  const listData = await expectStatus("staging Eventing subscription list", listed, 200);
  const listedSubscription = listData?.items?.find?.((item) => item.id === subscriptionId);
  if (!listedSubscription || listedSubscription.signingSecret !== undefined || listedSubscription.signingConfigured !== true) {
    throw new Error("Staging Eventing subscription read did not preserve one-time secret semantics");
  }

  await installSinkSecret(signingSecret);
  await poll(
    "staging Eventing smoke sink secret binding",
    async () => {
      const response = await fetch(`${sinkBase}/ready`);
      return { response, payload: await response.text() };
    },
    ({ response }) => response.status === 200,
    { attempts: 20, delayMs: 1000 },
  );

  const testSend = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const testData = await expectStatus("signed staging Webhook test", testSend, 200);
  if (testData?.ok !== true || testData?.statusCode !== 204) {
    throw new Error(`Staging Webhook test sink rejected the signed request: ${JSON.stringify(testData)}`);
  }

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const created = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      summary: `Staging Eventing ${marker}`,
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
    "real staging Eventing outbox/Queue/Webhook delivery",
    () => request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}/deliveries`, { bearer: managerBearer }),
    ({ response, payload }) => response.status === 200 && payload?.data?.items?.some?.((item) => item.recordId === eventId && item.eventType === "record.created" && item.status === "succeeded" && item.lastStatusCode === 204),
    { attempts: 36, delayMs: 5000 },
  );
  const delivery = deliveryPoll.payload.data.items.find((item) => item.recordId === eventId && item.eventType === "record.created");

  const revoked = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    bearer: managerBearer,
  });
  await expectStatus("staging Eventing Grant revoke", revoked, 204);
  grantActive = false;

  const deniedAfterRevoke = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  await expectStatus("subscription test after subscriber Grant revoke", deniedAfterRevoke, 403, "EVENT_SUBSCRIBER_ACCESS_DENIED");

  verification = {
    ok: true,
    worker: workerName,
    subscriberServicePrincipalId: subscriberPrincipalId,
    subscriptionId,
    subscriberGrantRequired: true,
    signingSecretOneTime: true,
    signedTestStatusCode: testData.statusCode,
    domainEvent: { modelKey: "event", recordId: eventId, version: eventVersion },
    delivery: { id: delivery.id, eventId: delivery.eventId, status: delivery.status, attemptCount: delivery.attemptCount, lastStatusCode: delivery.lastStatusCode },
    realPath: "event mutation -> D1 outbox -> scheduled dispatcher -> Cloudflare Queue -> HMAC Webhook",
    grantRevocationRechecked: true,
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
  if (sinkBase) {
    await cleanup("temporary workers.dev sink delete", async () => {
      await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "DELETE" });
    });
  }
}

if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Staging Eventing smoke cleanup failed: ${cleanupErrors.join(" | ")}`);

console.log(JSON.stringify({ ...verification, cleanup: { temporarySinkDeleted: true, subscriberDisabled: true, applicationScopeRestored: true } }, null, 2));
