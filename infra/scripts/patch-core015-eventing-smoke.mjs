import fs from "node:fs";

const path = "infra/scripts/verify-staging-eventing.mjs";
let text = fs.readFileSync(path, "utf8");

function replaceOnce(from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing ${label}`);
  text = text.replace(from, to);
}

replaceOnce(
`    if (request.headers.get("x-lifespace-test") === "true") {
      if (!exactKeys(payload, ["id", "type", "subscriptionId", "spaceId", "subscriberServicePrincipalId", "modelKey", "occurredAt"])) return bad("test payload is not reference-only");
      if (payload.type !== "subscription.test" || payload.modelKey !== "event") return bad("test payload semantics invalid");
      if (request.headers.get("x-lifespace-subscription-id") !== payload.subscriptionId) return bad("test subscription header mismatch");
      return new Response(null, { status: 204 });
    }`,
`    if (request.headers.get("x-lifespace-test") === "true") {
      if (!exactKeys(payload, ["id", "type", "endpointId", "spaceId", "subscriberServicePrincipalId", "occurredAt"])) return bad("test payload is not reference-only");
      if (payload.type !== "endpoint.test") return bad("test payload semantics invalid");
      if (request.headers.get("x-lifespace-webhook-endpoint-id") !== payload.endpointId) return bad("test endpoint header mismatch");
      return new Response(null, { status: 204 });
    }`,
"endpoint test payload block",
);

replaceOnce(
`    if (!request.headers.get("x-lifespace-delivery-id") || !request.headers.get("x-lifespace-subscription-id")) return bad("delivery headers missing");`,
`    if (!request.headers.get("x-lifespace-delivery-id") || !request.headers.get("x-lifespace-webhook-endpoint-id") || !request.headers.get("x-lifespace-subscription-id")) return bad("delivery headers missing");`,
"real delivery headers",
);

replaceOnce(
`let grantActive = false;
let subscriptionId = "";`,
`let grantActive = false;
let endpointId = "";
let subscriptionId = "";`,
"endpoint state declaration",
);

const flowStart = text.indexOf('  const webhookUrl = `${sinkBase}/webhook`;');
const flowEnd = text.indexOf("  verification = {", flowStart);
if (flowStart < 0 || flowEnd < 0) throw new Error("Eventing smoke flow markers not found");
const newFlow = `  const webhookUrl = \`${"${sinkBase}"}/webhook\`;
  const endpoint = await request(coreBase, "/api/v1/webhook-endpoints", {
    method: "POST",
    bearer: managerBearer,
    body: {
      spaceId,
      subscriberServicePrincipalId: subscriberPrincipalId,
      name: \`Staging Eventing ${"${suffix}"}\`.slice(0, 80),
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

  const listedEndpoints = await request(coreBase, \`/api/v1/webhook-endpoints?spaceId=${"${encodeURIComponent(spaceId)}"}&subscriberServicePrincipalId=${"${encodeURIComponent(subscriberPrincipalId)}"}\`, {
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

  const grant = await request(coreBase, \`/api/v1/spaces/${"${encodeURIComponent(spaceId)}"}/grants\`, {
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

  const listedSubscriptions = await request(coreBase, \`/api/v1/event-subscriptions?endpointId=${"${encodeURIComponent(endpointId)}"}\`, {
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
      const response = await fetch(\`${"${sinkBase}"}/ready\`);
      return { response, payload: await response.text() };
    },
    ({ response }) => response.status === 200,
    { attempts: 60, delayMs: 2000 },
  );

  const testSend = await request(coreBase, \`/api/v1/webhook-endpoints/${"${encodeURIComponent(endpointId)}"}/test\`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const testData = await expectStatus("signed staging Webhook Endpoint test", testSend, 200);
  if (testData?.ok !== true || testData?.statusCode !== 204) {
    throw new Error(\`Staging Webhook Endpoint test sink rejected the signed request: ${"${JSON.stringify(testData)}"}\`);
  }

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const created = await request(coreBase, \`/api/v1/spaces/${"${encodeURIComponent(spaceId)}"}/events\`, {
    method: "POST",
    bearer: managerBearer,
    body: {
      summary: \`Staging Eventing ${"${suffix}"}\`,
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
    () => request(coreBase, \`/api/v1/webhook-endpoints/${"${encodeURIComponent(endpointId)}"}/deliveries\`, { bearer: managerBearer }),
    ({ response, payload }) => response.status === 200 && payload?.data?.items?.some?.((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created" && item.status === "succeeded" && item.lastStatusCode === 204),
    { attempts: 50, delayMs: 3000 },
  );
  const delivery = deliveryPoll.payload.data.items.find((item) => item.recordId === eventId && item.modelKey === "event" && item.eventType === "record.created");

  const revoked = await request(coreBase, \`/api/v1/spaces/${"${encodeURIComponent(spaceId)}"}/grants/${"${encodeURIComponent(grantId)}"}\`, {
    method: "DELETE",
    bearer: managerBearer,
  });
  await expectStatus("staging Eventing Grant revoke", revoked, 204);
  grantActive = false;

  const deniedAfterRevoke = await request(coreBase, \`/api/v1/event-subscriptions/${"${encodeURIComponent(subscriptionId)}"}\`, {
    method: "PATCH",
    bearer: managerBearer,
    body: { eventTypes: ["record.created", "record.updated"] },
  });
  await expectStatus("subscription filter update after subscriber Grant revoke", deniedAfterRevoke, 403, "EVENT_SUBSCRIBER_ACCESS_DENIED");

  const endpointTestAfterRevoke = await request(coreBase, \`/api/v1/webhook-endpoints/${"${encodeURIComponent(endpointId)}"}/test\`, {
    method: "POST",
    bearer: managerBearer,
    body: {},
  });
  const endpointTestAfterRevokeData = await expectStatus("Webhook Endpoint transport test after model Grant revoke", endpointTestAfterRevoke, 200);
  if (endpointTestAfterRevokeData?.ok !== true || endpointTestAfterRevokeData?.statusCode !== 204) {
    throw new Error("Webhook Endpoint transport/signature test should remain independent from model Data Grant state");
  }

`;
text = text.slice(0, flowStart) + newFlow + text.slice(flowEnd);

const verificationStart = text.indexOf("  verification = {", flowStart);
const catchMarker = text.indexOf("} catch (error) {", verificationStart);
if (verificationStart < 0 || catchMarker < 0) throw new Error("Verification block markers not found");
const newVerification = `  verification = {
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
`;
text = text.slice(0, verificationStart) + newVerification + text.slice(catchMarker);

const cleanupSubscription = `  if (subscriptionId && managerBearer) {
    await cleanup("subscription delete", async () => {
      const result = await request(coreBase, \`/api/v1/event-subscriptions/${"${encodeURIComponent(subscriptionId)}"}\`, { method: "DELETE", bearer: managerBearer });
      if (![204, 404].includes(result.response.status)) throw new Error(\`HTTP ${"${result.response.status}"}\`);
    });
  }
`;
if (!text.includes(cleanupSubscription)) throw new Error("Subscription cleanup block not found");
text = text.replace(cleanupSubscription, `${cleanupSubscription}  if (endpointId && managerBearer) {
    await cleanup("Webhook Endpoint delete", async () => {
      const result = await request(coreBase, \`/api/v1/webhook-endpoints/${"${encodeURIComponent(endpointId)}"}\`, { method: "DELETE", bearer: managerBearer });
      if (![204, 404].includes(result.response.status)) throw new Error(\`HTTP ${"${result.response.status}"}\`);
    });
  }
`);

fs.writeFileSync(path, text);
console.log("Updated staging Eventing smoke for Core 0.15 Webhook Endpoint/filter split");
