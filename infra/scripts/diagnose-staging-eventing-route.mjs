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
const workerName = `lifespace-eventing-diag-${runId}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 63);

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
function hex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function sameText(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
async function expectedSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + "." + rawBody));
  return "v1=" + hex(new Uint8Array(signed));
}
function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}
function bad(message, status = 400) { return new Response(message, { status }); }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method === "GET" && url.pathname === "/ready") return env.EVENTING_SIGNING_SECRET ? new Response("ready") : bad("secret missing", 503);
    if (request.method !== "POST") return new Response(null, { status: 205 });
    if (!env.EVENTING_SIGNING_SECRET) return bad("secret missing", 503);
    const timestamp = request.headers.get("x-lifespace-timestamp") || "";
    const supplied = request.headers.get("x-lifespace-signature") || "";
    const timestampNumber = Number(timestamp);
    if (!Number.isInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) return bad("timestamp invalid", 401);
    const rawBody = await request.text();
    const expected = await expectedSignature(env.EVENTING_SIGNING_SECRET, timestamp, rawBody);
    if (!sameText(expected, supplied)) return bad("signature invalid", 401);
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return bad("body invalid"); }
    if (request.headers.get("x-lifespace-test") === "true") {
      if (url.pathname !== "/webhook") return bad("test path mismatch", 409);
      if (!exactKeys(payload, ["id", "type", "subscriptionId", "spaceId", "subscriberServicePrincipalId", "modelKey", "occurredAt"])) return bad("test payload invalid");
      if (payload.type !== "subscription.test" || payload.modelKey !== "event") return bad("test semantics invalid");
      return new Response(null, { status: 204 });
    }
    if (!exactKeys(payload, ["id", "type", "spaceId", "modelKey", "recordId", "recordVersion", "occurredAt"])) return bad("domain payload invalid");
    if (payload.type !== "record.created" || payload.modelKey !== "event") return bad("domain semantics invalid");
    if (request.headers.get("x-lifespace-event-id") !== payload.id) return bad("event header mismatch");
    if (!request.headers.get("x-lifespace-delivery-id") || !request.headers.get("x-lifespace-subscription-id")) return bad("delivery headers missing");
    const status = url.pathname === "/webhook" ? 204 : url.pathname === "/" ? 201 : url.pathname === "/webhook/" ? 202 : 203;
    return new Response(null, { status });
  },
};
`;

function mask(value) { if (typeof value === "string" && value) console.log(`::add-mask::${value}`); }
async function readResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
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
  else if (body !== undefined) { headers["content-type"] = "application/json"; requestBody = JSON.stringify(body); }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: requestBody });
  const payload = await readResponse(response);
  if (!response.ok || payload?.success === false) throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${JSON.stringify(payload?.errors ?? payload)}`);
  return payload;
}
async function expectStatus(label, result, expectedStatus, expectedCode = null) {
  if (result.response.status !== expectedStatus || (expectedCode && result.payload?.error?.code !== expectedCode)) {
    throw new Error(`${label}: expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}
async function poll(label, action, predicate, { attempts = 40, delayMs = 3000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { last = await action(); if (predicate(last)) return last; } catch (error) { last = { error }; }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} did not converge: ${last?.response ? `${last.response.status} ${JSON.stringify(last.payload)}` : String(last?.error ?? "no result")}`);
}
async function workersDevBase() {
  const result = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = result?.result?.subdomain;
  if (typeof subdomain !== "string" || !subdomain) throw new Error("Cloudflare account workers.dev subdomain is unavailable");
  return `https://${workerName}.${subdomain}.workers.dev`;
}
async function deploySinkOnce(signingSecret) {
  const form = new FormData();
  form.set("metadata", new File([JSON.stringify({
    main_module: "worker.mjs",
    compatibility_date: "2026-08-08",
    bindings: [{ type: "secret_text", name: "EVENTING_SIGNING_SECRET", text: signingSecret }],
  })], "metadata.json", { type: "application/json" }));
  form.set("worker.mjs", new File([sinkSource], "worker.mjs", { type: "application/javascript+module" }));
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "PUT", form });
  await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, { method: "POST", body: { enabled: true, previews_enabled: false } });
}

let sinkBase = "";
let originalScopes = null;
let scopesChanged = false;
let managerBearer = "";
let subscriberId = "";
let grantId = "";
let grantActive = false;
let subscriptionId = "";
let eventId = "";
let eventVersion = 0;
let primaryError = null;
const cleanupErrors = [];

try {
  sinkBase = await workersDevBase();
  const app = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: bootstrapSecret });
  const appData = await expectStatus("smoke application metadata", app, 200);
  originalScopes = [...(appData?.allowedScopes ?? [])];
  if (!originalScopes.includes("grants:manage")) {
    const updated = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
      method: "PATCH", bootstrap: bootstrapSecret, body: { allowedScopes: [...originalScopes, "grants:manage"] },
    });
    await expectStatus("temporary grants:manage", updated, 200);
    scopesChanged = true;
  }
  const issued = await request(identityBase, "/internal/v1/tokens", {
    method: "POST", bearer: applicationSecret,
    body: { subjectId: userId, scopes: ["spaces:manage", "grants:manage", "resources:read", "resources:write"] },
  });
  managerBearer = (await expectStatus("manager token", issued, 200))?.accessToken ?? "";
  if (!managerBearer) throw new Error("manager token missing");
  mask(managerBearer);

  const principal = await request(identityBase, "/api/v1/service-principals", {
    method: "POST", bearer: applicationSecret,
    body: { displayName: `Eventing route diagnostic ${runId}`.slice(0, 100), maxScopes: ["resources:read"], createdByUserId: userId },
  });
  subscriberId = (await expectStatus("subscriber principal", principal, 201))?.id ?? "";
  if (!subscriberId) throw new Error("subscriber principal missing");

  const grant = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants`, {
    method: "POST", bearer: managerBearer,
    body: { granteeType: "service", granteeId: subscriberId, resourceType: "model", resourceId: "event", permission: "read", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
  });
  grantId = (await expectStatus("subscriber event Grant", grant, 201))?.id ?? "";
  if (!grantId) throw new Error("subscriber Grant missing");
  grantActive = true;

  const subscription = await request(coreBase, "/api/v1/event-subscriptions", {
    method: "POST", bearer: managerBearer,
    body: { spaceId, subscriberServicePrincipalId: subscriberId, name: `Route diagnostic ${runId}`.slice(0, 80), modelKey: "event", eventTypes: ["record.created"], webhookUrl: `${sinkBase}/webhook` },
  });
  const subscriptionData = await expectStatus("Eventing subscription", subscription, 201);
  subscriptionId = subscriptionData?.id ?? "";
  const signingSecret = subscriptionData?.signingSecret ?? "";
  if (!subscriptionId || typeof signingSecret !== "string" || signingSecret.length < 64) throw new Error("subscription signing secret missing");
  mask(signingSecret);

  await deploySinkOnce(signingSecret);
  await poll("single-deployment sink readiness", async () => {
    const response = await fetch(`${sinkBase}/ready`);
    return { response, payload: await response.text() };
  }, ({ response }) => response.status === 200, { attempts: 30, delayMs: 1000 });

  const testSend = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}/test`, { method: "POST", bearer: managerBearer, body: {} });
  const testData = await expectStatus("signed test delivery", testSend, 200);
  if (testData?.ok !== true || testData?.statusCode !== 204) throw new Error(`test delivery did not hit exact /webhook: ${JSON.stringify(testData)}`);

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const created = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events`, {
    method: "POST", bearer: managerBearer,
    body: { summary: `Eventing diagnostic ${runId}`, isAllDay: false, startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60 * 1000).toISOString(), startTimezone: "UTC", endTimezone: "UTC", attendeePersonIds: [personId] },
  });
  const event = await expectStatus("diagnostic event mutation", created, 201);
  eventId = event?.id ?? "";
  eventVersion = event?.version ?? 0;
  if (!eventId || !Number.isInteger(eventVersion)) throw new Error("diagnostic event record invalid");

  const observed = await poll("first asynchronous delivery attempt", () => request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}/deliveries`, { bearer: managerBearer }), ({ response, payload }) => {
    if (response.status !== 200) return false;
    const item = payload?.data?.items?.find?.((candidate) => candidate.recordId === eventId && candidate.eventType === "record.created");
    return Boolean(item && item.attemptCount >= 1 && (item.lastStatusCode !== null || item.status === "cancelled"));
  }, { attempts: 40, delayMs: 3000 });
  const delivery = observed.payload.data.items.find((candidate) => candidate.recordId === eventId && candidate.eventType === "record.created");
  const classification = delivery.lastStatusCode === 204 ? "exact-/webhook"
    : delivery.lastStatusCode === 201 ? "signed-domain-request-reached-root-path"
    : delivery.lastStatusCode === 202 ? "signed-domain-request-reached-/webhook/-with-trailing-slash"
    : delivery.lastStatusCode === 203 ? "signed-domain-request-reached-another-path"
    : delivery.lastStatusCode === 205 ? "receiver-observed-non-POST-method"
    : delivery.lastStatusCode === 404 ? "404-before-diagnostic-receiver-handler-or-non-diagnostic-version"
    : `unexpected-status-${delivery.lastStatusCode}`;
  console.log(JSON.stringify({
    diagnostic: true,
    receiverDeployment: "single upload with secret_text binding",
    directTestStatusCode: testData.statusCode,
    delivery: { id: delivery.id, status: delivery.status, attemptCount: delivery.attemptCount, lastStatusCode: delivery.lastStatusCode, lastError: delivery.lastError },
    classification,
  }, null, 2));
  if (delivery.status !== "succeeded" || delivery.lastStatusCode !== 204) throw new Error(`Eventing route diagnostic classification: ${classification}`);
} catch (error) {
  primaryError = error;
} finally {
  async function cleanup(label, action) {
    try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (subscriptionId && managerBearer) await cleanup("subscription delete", async () => {
    const result = await request(coreBase, `/api/v1/event-subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE", bearer: managerBearer });
    if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
  });
  if (grantActive && grantId && managerBearer) await cleanup("Grant revoke", async () => {
    const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE", bearer: managerBearer });
    if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
  });
  if (eventId && eventVersion && managerBearer) await cleanup("event delete", async () => {
    const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", bearer: managerBearer, body: { version: eventVersion } });
    if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
  });
  if (subscriberId) await cleanup("subscriber disable", async () => {
    const result = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(subscriberId)}`, { method: "PATCH", bearer: applicationSecret, body: { status: "disabled" } });
    if (![200, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
  });
  if (scopesChanged && originalScopes) await cleanup("application scopes restore", async () => {
    const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { method: "PATCH", bootstrap: bootstrapSecret, body: { allowedScopes: originalScopes } });
    if (result.response.status !== 200) throw new Error(`HTTP ${result.response.status}`);
  });
  if (sinkBase) await cleanup("diagnostic sink delete", async () => {
    await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "DELETE" });
  });
}
if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Eventing diagnostic cleanup failed: ${cleanupErrors.join(" | ")}`);
console.log(JSON.stringify({ ok: true, diagnostic: "real Eventing path reached exact /webhook", cleanup: true }, null, 2));
