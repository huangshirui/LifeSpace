import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET;
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const smokeId = `${runId}_${runAttempt}`;

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!bootstrapSecret || bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must be configured and at least 32 characters long");
}

const identityBase = "https://auth-staging.aisr.online";
const coreBase = "https://core-staging.aisr.online";

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function wranglerSecretBulk(cwd, secrets) {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", "secret", "bulk", "--env", "staging"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret bulk failed in ${cwd} with exit code ${code}`));
    });

    child.stdin.end(JSON.stringify(secrets));
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function requestJson(url, init, expectedStatus) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const { response, payload } = await fetchJson(url, init);
      if (response.status === expectedStatus) return payload;
      lastError = new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${JSON.stringify(payload)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw lastError;
}

async function issueToken(clientSecret, userId, scopes) {
  return fetchJson(`${identityBase}/internal/v1/tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clientSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ subjectId: userId, scopes }),
  });
}

async function probeCore(accessToken) {
  return fetchJson(`${coreBase}/api/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function rotateSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await wranglerSecretBulk("apps/identity", {
    TOKEN_PRIVATE_KEY: privateKey,
    TOKEN_PUBLIC_KEY: publicKey,
    BOOTSTRAP_SECRET: bootstrapSecret,
  });
  await wranglerSecretBulk("apps/core", {
    IDENTITY_PUBLIC_KEY: publicKey,
  });
  console.log("Generated, installed, and activated a new staging RS256 signing key pair");
}

const coreIdentitySharedSecret = randomBytes(32).toString("base64url");
await wranglerSecretBulk("apps/identity", {
  BOOTSTRAP_SECRET: bootstrapSecret,
  CORE_IDENTITY_SHARED_SECRET: coreIdentitySharedSecret,
});
await wranglerSecretBulk("apps/core", {
  CORE_IDENTITY_SHARED_SECRET: coreIdentitySharedSecret,
});
console.log("Staging bootstrap and Core↔Identity introspection secrets synchronized and activated");

// Identity 0.2 adds user-token verification at the Identity resource server.
// Rotate the staging-only pair once per staging deployment so Identity and Core
// are guaranteed to share the same active public key before profile smoke tests.
await rotateSigningKeys();

const appId = `app_staging_smoke_${smokeId}`;
const displayName = `Staging Smoke ${smokeId}`;
const scopes = [
  "profile:read",
  "profile:write",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "grants:manage",
  "creation-drafts:read",
  "creation-drafts:write",
  "events:read",
  "events:write",
  "tasks:read",
  "tasks:write",
  "day-records:read",
  "day-records:write",
  "wishes:read",
  "wishes:write",
];

const application = await requestJson(`${identityBase}/bootstrap/v1/applications`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-bootstrap-secret": bootstrapSecret,
  },
  body: JSON.stringify({
    id: appId,
    name: "LifeSpace staging smoke test",
    clientType: "service",
    allowedScopes: scopes,
    trustedBackend: true,
    accessTokenTtlSeconds: 300,
  }),
}, 201);

const clientSecret = application?.data?.clientSecret;
if (!clientSecret) throw new Error("Smoke application did not return a client secret");

const user = await requestJson(`${identityBase}/internal/v1/users`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${clientSecret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ displayName }),
}, 201);

const userId = user?.data?.id;
if (!userId) throw new Error("Smoke user creation did not return a user id");

let rotatedSigningKeys = true;
let tokenProbe = await issueToken(clientSecret, userId, scopes);
let accessToken = tokenProbe.payload?.data?.accessToken;
let coreProbe = accessToken ? await probeCore(accessToken) : null;

const identityKeyMissing =
  tokenProbe.response.status === 500 && tokenProbe.payload?.error?.code === "IDENTITY_NOT_CONFIGURED";
const coreKeyMissingOrMismatched = accessToken && coreProbe?.response.status === 401;

if (identityKeyMissing || coreKeyMissingOrMismatched) {
  console.log(
    identityKeyMissing
      ? "Active Identity signing key is missing; repairing staging signing keys"
      : "Active Core verification key is missing or mismatched; repairing staging signing keys",
  );
  await rotateSigningKeys();
  rotatedSigningKeys = true;

  tokenProbe = await issueToken(clientSecret, userId, scopes);
  accessToken = tokenProbe.payload?.data?.accessToken;
  if (tokenProbe.response.status !== 200 || !accessToken) {
    throw new Error(`Identity token issuance failed after signing-key repair: ${tokenProbe.response.status} ${JSON.stringify(tokenProbe.payload)}`);
  }

  coreProbe = await probeCore(accessToken);
}

if (tokenProbe.response.status !== 200 || !accessToken) {
  throw new Error(`Identity token issuance failed: ${tokenProbe.response.status} ${JSON.stringify(tokenProbe.payload)}`);
}
if (coreProbe?.response.status !== 200) {
  throw new Error(`Core token verification failed: ${coreProbe?.response.status} ${JSON.stringify(coreProbe?.payload)}`);
}

const profile = await requestJson(`${identityBase}/api/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (profile?.data?.id !== userId || profile?.data?.displayName !== displayName || profile?.data?.avatarUrl !== null) {
  throw new Error(`Unexpected Identity profile: ${JSON.stringify(profile)}`);
}
const updatedProfileName = `${displayName} Updated`;
const updatedProfile = await requestJson(`${identityBase}/api/v1/me`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ displayName: updatedProfileName }),
}, 200);
if (updatedProfile?.data?.displayName !== updatedProfileName) throw new Error(`Identity profile update failed: ${JSON.stringify(updatedProfile)}`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2dAAAAABJRU5ErkJggg==", "base64");
const userAvatarForm = new FormData();
userAvatarForm.set("file", new Blob([png], { type: "image/png" }), "avatar.png");
const uploadedUserAvatar = await requestJson(`${identityBase}/api/v1/me/avatar`, {
  method: "PUT", headers: { authorization: `Bearer ${accessToken}` }, body: userAvatarForm,
}, 200);
const userAvatarUrl = uploadedUserAvatar?.data?.avatarUrl;
if (!userAvatarUrl) throw new Error(`Identity avatar upload did not return a URL: ${JSON.stringify(uploadedUserAvatar)}`);
const userAvatarResponse = await fetch(userAvatarUrl);
if (userAvatarResponse.status !== 200 || userAvatarResponse.headers.get("content-type") !== "image/png") {
  throw new Error(`Identity public avatar read failed: ${userAvatarResponse.status} ${userAvatarResponse.headers.get("content-type")}`);
}

const identityStatus = await requestJson(`${identityBase}/api/v1/status`, {}, 200);
if (identityStatus?.data?.environment !== "staging" || identityStatus?.data?.schemaVersion !== "4" || identityStatus?.data?.contractVersion !== "0.3.0") {
  throw new Error(`Unexpected Identity staging status: ${JSON.stringify(identityStatus)}`);
}

const coreStatus = await requestJson(`${coreBase}/api/v1/status`, {}, 200);
if (
  coreStatus?.data?.environment !== "staging"
  || coreStatus?.data?.schemaVersion !== "9"
  || coreStatus?.data?.contractVersion !== "0.11.0"
) {
  throw new Error(`Unexpected Core staging status: ${JSON.stringify(coreStatus)}`);
}

const space = await requestJson(`${coreBase}/api/v1/spaces`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    kind: "personal",
    name: `Staging Smoke ${smokeId}`,
    ownerDisplayName: displayName,
    timezone: "UTC",
  }),
}, 201);

const spaceId = space?.data?.id;
const ownerPersonId = space?.data?.ownerPersonId;
if (!spaceId) throw new Error("Core did not return a Space id");
if (!ownerPersonId) throw new Error("Core did not return the owner Space Person id");
if (space?.data?.avatarUrl !== null || space?.data?.version !== 1) throw new Error(`Unexpected initial Space avatar state: ${JSON.stringify(space)}`);

const servicePrincipal = await requestJson(`${identityBase}/api/v1/service-principals`, {
  method: "POST",
  headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
  body: JSON.stringify({
    displayName: `Staging n8n ${smokeId}`,
    description: "Phase 2 service-auth staging smoke",
    maxScopes: ["spaces:read"],
    createdByUserId: userId,
  }),
}, 201);
const servicePrincipalId = servicePrincipal?.data?.id;
if (!servicePrincipalId?.startsWith("svc_")) throw new Error(`Identity did not return a service principal: ${JSON.stringify(servicePrincipal)}`);

const serviceTokenCreated = await requestJson(`${identityBase}/api/v1/service-principals/${servicePrincipalId}/tokens`, {
  method: "POST",
  headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
  body: JSON.stringify({ label: "staging n8n PAT", scopes: ["spaces:read"], createdByUserId: userId }),
}, 201);
const serviceToken = serviceTokenCreated?.data?.token;
const serviceTokenId = serviceTokenCreated?.data?.id;
if (!serviceToken?.startsWith("lsp_pat_") || !serviceTokenId?.startsWith("sat_")) throw new Error(`Identity did not return a one-time lsp_pat token: ${JSON.stringify(serviceTokenCreated)}`);
const tokenMetadata = await requestJson(`${identityBase}/api/v1/service-principals/${servicePrincipalId}/tokens`, {
  headers: { authorization: `Bearer ${clientSecret}` },
}, 200);
if (JSON.stringify(tokenMetadata).includes(serviceToken)) throw new Error("Service token listing leaked plaintext");

const serviceGrant = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/grants`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ granteeType: "service", granteeId: servicePrincipalId, permission: "read", expiresAt: null }),
}, 201);
const serviceGrantId = serviceGrant?.data?.id;
if (!serviceGrantId?.startsWith("grt_")) throw new Error(`Core did not return a service Data Grant: ${JSON.stringify(serviceGrant)}`);

const serviceRead = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {
  headers: { authorization: `Bearer ${serviceToken}` },
}, 200);
if (serviceRead?.data?.id !== spaceId || serviceRead?.data?.access !== "grant") throw new Error(`Opaque Service API Token did not reach Core through current Grant: ${JSON.stringify(serviceRead)}`);

const oauthCredential = await requestJson(`${identityBase}/api/v1/service-principals/${servicePrincipalId}/oauth-credentials`, {
  method: "POST",
  headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
  body: JSON.stringify({ label: "staging OAuth", createdByUserId: userId }),
}, 201);
const oauthClientSecret = oauthCredential?.data?.clientSecret;
const oauthCredentialId = oauthCredential?.data?.id;
if (!oauthClientSecret?.startsWith("lsp_client_") || !oauthCredentialId?.startsWith("soc_")) throw new Error(`Identity did not return OAuth client credentials: ${JSON.stringify(oauthCredential)}`);
const oauthForm = new URLSearchParams({ grant_type: "client_credentials", client_id: servicePrincipalId, client_secret: oauthClientSecret, scope: "spaces:read" });
const oauthToken = await requestJson(`${identityBase}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: oauthForm.toString(),
}, 200);
const oauthAccessToken = oauthToken?.access_token;
if (!oauthAccessToken) throw new Error(`OAuth client_credentials did not return an access token: ${JSON.stringify(oauthToken)}`);
const oauthRead = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${oauthAccessToken}` } }, 200);
if (oauthRead?.data?.id !== spaceId || oauthRead?.data?.access !== "grant") throw new Error(`OAuth service token did not use the current Data Grant: ${JSON.stringify(oauthRead)}`);

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/grants/${serviceGrantId}`, {
  method: "DELETE", headers: { authorization: `Bearer ${accessToken}` },
}, 204);
const opaqueAfterGrantRevoke = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${serviceToken}` } });
if (opaqueAfterGrantRevoke.response.status !== 403) throw new Error(`Opaque service Grant revocation did not take effect immediately: ${opaqueAfterGrantRevoke.response.status} ${JSON.stringify(opaqueAfterGrantRevoke.payload)}`);
const oauthAfterGrantRevoke = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${oauthAccessToken}` } });
if (oauthAfterGrantRevoke.response.status !== 403) throw new Error(`OAuth service Grant revocation did not take effect immediately: ${oauthAfterGrantRevoke.response.status} ${JSON.stringify(oauthAfterGrantRevoke.payload)}`);

await requestJson(`${identityBase}/api/v1/service-principals/${servicePrincipalId}/tokens/${serviceTokenId}`, {
  method: "DELETE", headers: { authorization: `Bearer ${clientSecret}`, "x-lifespace-actor-user-id": userId },
}, 204);
const opaqueAfterTokenRevoke = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${serviceToken}` } });
if (opaqueAfterTokenRevoke.response.status !== 401) throw new Error(`Opaque token revocation did not take effect immediately: ${opaqueAfterTokenRevoke.response.status} ${JSON.stringify(opaqueAfterTokenRevoke.payload)}`);
await requestJson(`${identityBase}/api/v1/service-principals/${servicePrincipalId}/oauth-credentials/${oauthCredentialId}`, {
  method: "DELETE", headers: { authorization: `Bearer ${clientSecret}`, "x-lifespace-actor-user-id": userId },
}, 204);
console.log(`Phase 2 service authentication staging E2E passed for ${servicePrincipalId} / ${spaceId}`);

const creationDraft = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/creation-drafts`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ text: "明天买牛奶", viewingTimezone: "Asia/Shanghai" }),
}, 202);
const creationDraftId = creationDraft?.data?.draftId;
if (!creationDraftId?.startsWith("drf_") || creationDraft?.data?.status !== "processing") throw new Error(`Creation draft enqueue failed: ${JSON.stringify(creationDraft)}`);
let creationDraftTerminal = null;
for (let attempt = 1; attempt <= 15; attempt += 1) {
  const current = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/creation-drafts/${creationDraftId}`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
  if (["ready", "choose_kind", "failed"].includes(current?.data?.status)) { creationDraftTerminal = current; break; }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!creationDraftTerminal) throw new Error("Creation draft Queue consumer did not reach a terminal state");
if (creationDraftTerminal.data.status === "failed" && !creationDraftTerminal.data.error?.code?.startsWith("AI_")) throw new Error(`Unexpected creation draft failure: ${JSON.stringify(creationDraftTerminal)}`);
console.log(`Core 0.11 creation draft Queue E2E reached ${creationDraftTerminal.data.status} for ${creationDraftId}`);

const spaceAvatarForm = new FormData();
spaceAvatarForm.set("file", new Blob([png], { type: "image/png" }), "space-avatar.png");
spaceAvatarForm.set("version", "1");
const uploadedSpaceAvatar = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/avatar`, {
  method: "PUT", headers: { authorization: `Bearer ${accessToken}` }, body: spaceAvatarForm,
}, 200);
if (!uploadedSpaceAvatar?.data?.avatarUrl || uploadedSpaceAvatar?.data?.version !== 2) {
  throw new Error(`Space avatar upload failed: ${JSON.stringify(uploadedSpaceAvatar)}`);
}
const spaceAvatarResponse = await fetch(uploadedSpaceAvatar.data.avatarUrl);
if (spaceAvatarResponse.status !== 200 || spaceAvatarResponse.headers.get("content-type") !== "image/png") {
  throw new Error(`Space public avatar read failed: ${spaceAvatarResponse.status} ${spaceAvatarResponse.headers.get("content-type")}`);
}
const spaceRead = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
}, 200);
if (spaceRead?.data?.avatarUrl !== uploadedSpaceAvatar.data.avatarUrl || spaceRead?.data?.version !== 2) {
  throw new Error(`Space avatar was not reflected in Space DTO: ${JSON.stringify(spaceRead)}`);
}
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {}, 401);

const retiredFamily = await fetchJson(`${coreBase}/api/v1/families`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
if (retiredFamily.response.status !== 404 || retiredFamily.payload?.error?.code !== "NOT_FOUND") {
  throw new Error(`Retired HomeMew family route is still reachable: ${retiredFamily.response.status} ${JSON.stringify(retiredFamily.payload)}`);
}

const eventSummary = `Staging Smoke Event ${smokeId}`;
const event = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/events`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({
    summary: eventSummary,
    description: "Core 0.8 native-only staging E2E",
    isAllDay: true,
    startDate: "2099-06-01",
    endDateExclusive: "2099-06-02",
    attendeePersonIds: [ownerPersonId],
  }),
}, 201);
const eventId = event?.data?.id;
if (!eventId) throw new Error("Core did not return an Event id");
if (event.data?.spaceId !== spaceId || event.data?.isAllDay !== true || event.data?.attendees?.[0]?.personId !== ownerPersonId || event.data?.version !== 1) {
  throw new Error(`Unexpected created Event shape: ${JSON.stringify(event)}`);
}
const eventList = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/events?startDate=2099-06-01&endDateExclusive=2099-06-02&attendeePersonId=me&q=${encodeURIComponent(eventSummary)}`, {
  headers: { authorization: `Bearer ${accessToken}` },
}, 200);
if (eventList?.data?.items?.length !== 1 || eventList.data.items[0]?.id !== eventId) throw new Error(`Event list/filter E2E failed: ${JSON.stringify(eventList)}`);
const updatedEvent = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/events/${eventId}`, {
  method: "PATCH",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ version: 1, description: "Core 0.8 native-only staging E2E updated" }),
}, 200);
if (updatedEvent?.data?.version !== 2 || updatedEvent?.data?.description !== "Core 0.8 native-only staging E2E updated") throw new Error(`Event update E2E failed: ${JSON.stringify(updatedEvent)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/events/${eventId}?version=2`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${accessToken}` },
}, 204);
const deletedEvent = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/events/${eventId}`, { headers: { authorization: `Bearer ${accessToken}` } });
if (deletedEvent.response.status !== 404 || deletedEvent.payload?.error?.code !== "EVENT_NOT_FOUND") throw new Error(`Event soft-delete E2E failed: ${deletedEvent.response.status} ${JSON.stringify(deletedEvent.payload)}`);
console.log(`Core 0.8 staging Event E2E passed for ${spaceId} / ${eventId}`);

const taskName = `Staging Smoke Task ${smokeId}`;
const task = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({
    name: taskName,
    description: "Phase 2.4 staging E2E",
    dueDate: "2099-12-31",
    assigneePersonIds: [ownerPersonId],
  }),
}, 201);
const taskId = task?.data?.id;
if (!taskId) throw new Error("Core did not return a Task id");
if (
  task.data?.spaceId !== spaceId || task.data?.status !== "pending" || task.data?.dueDate !== "2099-12-31"
  || task.data?.version !== 1 || task.data?.assignees?.length !== 1 || task.data?.assignees?.[0]?.personId !== ownerPersonId
) throw new Error(`Unexpected created Task shape: ${JSON.stringify(task)}`);

const taskList = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&q=${encodeURIComponent(taskName)}`,
  { headers: { authorization: `Bearer ${accessToken}` } }, 200,
);
if (taskList?.data?.items?.length !== 1 || taskList.data.items[0]?.id !== taskId) throw new Error(`Task list/filter E2E failed: ${JSON.stringify(taskList)}`);
const taskRead = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (taskRead?.data?.id !== taskId || taskRead?.data?.assignees?.[0]?.personId !== ownerPersonId) throw new Error(`Task read/assignee E2E failed: ${JSON.stringify(taskRead)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks`, {}, 401);

const staleUpdate = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ version: 999, description: "stale update must fail" }),
});
if (staleUpdate.response.status !== 409 || staleUpdate.payload?.error?.code !== "TASK_VERSION_CONFLICT") throw new Error(`Task optimistic-concurrency E2E failed: ${staleUpdate.response.status} ${JSON.stringify(staleUpdate.payload)}`);

const completedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}/complete`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1 }),
}, 200);
if (completedTask?.data?.status !== "completed" || completedTask?.data?.version !== 2 || completedTask?.data?.completedBy?.id !== userId) throw new Error(`Task complete E2E failed: ${JSON.stringify(completedTask)}`);
const reopenedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}/reopen`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 2 }),
}, 200);
if (reopenedTask?.data?.status !== "pending" || reopenedTask?.data?.version !== 3 || reopenedTask?.data?.completedAt !== null || reopenedTask?.data?.completedBy !== null) throw new Error(`Task reopen E2E failed: ${JSON.stringify(reopenedTask)}`);
const updatedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ version: 3, description: "Phase 2.4 staging E2E updated", dueDate: null, assigneePersonIds: [ownerPersonId] }),
}, 200);
if (updatedTask?.data?.version !== 4 || updatedTask?.data?.description !== "Phase 2.4 staging E2E updated" || updatedTask?.data?.dueDate !== null || updatedTask?.data?.assignees?.[0]?.personId !== ownerPersonId) throw new Error(`Task update E2E failed: ${JSON.stringify(updatedTask)}`);
const withoutNoDue = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&dueDateFrom=2099-01-01&q=${encodeURIComponent(taskName)}`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (withoutNoDue?.data?.items?.length !== 0) throw new Error(`Task includeNoDue omission E2E failed: ${JSON.stringify(withoutNoDue)}`);
const withNoDue = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&dueDateFrom=2099-01-01&includeNoDue=true&q=${encodeURIComponent(taskName)}`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (withNoDue?.data?.items?.length !== 1 || withNoDue.data.items[0]?.id !== taskId) throw new Error(`Task includeNoDue=true E2E failed: ${JSON.stringify(withNoDue)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}?version=4`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }, 204);
const deletedTask = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, { headers: { authorization: `Bearer ${accessToken}` } });
if (deletedTask.response.status !== 404 || deletedTask.payload?.error?.code !== "TASK_NOT_FOUND") throw new Error(`Task soft-delete E2E failed: ${deletedTask.response.status} ${JSON.stringify(deletedTask.payload)}`);
console.log(`Phase 2.4 staging Task E2E passed for ${spaceId} / ${taskId}`);

const smokeToday = new Date().toISOString().slice(0, 10);
const dayAnchor = addUtcDays(smokeToday, -1);
const expectedNextDue = addUtcDays(smokeToday, 30);
const dayName = `Staging Smoke Day ${smokeId}`;
const dayRecord = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ name: dayName, description: "Phase 2.5 staging E2E", kind: "cycle", anchorDate: dayAnchor, cycleDays: 30, subjectPersonId: ownerPersonId }),
}, 201);
const dayRecordId = dayRecord?.data?.id;
if (!dayRecordId) throw new Error("Core did not return a Day record id");
if (dayRecord.data?.spaceId !== spaceId || dayRecord.data?.kind !== "cycle" || dayRecord.data?.anchorDate !== dayAnchor || dayRecord.data?.nextDueDate !== addUtcDays(dayAnchor, 30) || dayRecord.data?.attentionBeforeDays !== 7 || dayRecord.data?.status !== "active" || dayRecord.data?.version !== 1 || dayRecord.data?.subject?.personId !== ownerPersonId) throw new Error(`Unexpected created Day record shape: ${JSON.stringify(dayRecord)}`);
const dayList = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records?kind=cycle&subjectPersonId=me&sort=created_desc`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (dayList?.data?.items?.length !== 1 || dayList.data.items[0]?.id !== dayRecordId) throw new Error(`Day record list/subject E2E failed: ${JSON.stringify(dayList)}`);
const initialOccurrences = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (initialOccurrences?.data?.items?.length !== 1 || initialOccurrences.data.items[0]?.occurredOn !== dayAnchor || initialOccurrences.data.items[0]?.source !== "initial" || initialOccurrences.data.items[0]?.intervalDays !== null) throw new Error(`Day initial occurrence E2E failed: ${JSON.stringify(initialOccurrences)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records`, {}, 401);
const staleDayUpdate = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 999, description: "stale update must fail" }),
});
if (staleDayUpdate.response.status !== 409 || staleDayUpdate.payload?.error?.code !== "DAY_RECORD_VERSION_CONFLICT") throw new Error(`Day optimistic-concurrency E2E failed: ${staleDayUpdate.response.status} ${JSON.stringify(staleDayUpdate.payload)}`);
const occurrence = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ occurredOn: smokeToday, note: "Phase 2.5 staging occurrence", version: 1 }),
}, 201);
if (occurrence?.data?.previousAnchorDate !== dayAnchor || occurrence?.data?.intervalDays !== 1 || occurrence?.data?.record?.anchorDate !== smokeToday || occurrence?.data?.record?.nextDueDate !== expectedNextDue || occurrence?.data?.record?.version !== 2) throw new Error(`Day occurrence/anchor E2E failed: ${JSON.stringify(occurrence)}`);
const occurrenceHistory = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (occurrenceHistory?.data?.items?.length !== 2 || occurrenceHistory.data.items[0]?.occurredOn !== smokeToday || occurrenceHistory.data.items[0]?.source !== "manual" || occurrenceHistory.data.items[0]?.intervalDays !== 1) throw new Error(`Day occurrence history E2E failed: ${JSON.stringify(occurrenceHistory)}`);
const archivedDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/archive`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 2 }),
}, 200);
if (archivedDay?.data?.status !== "archived" || archivedDay?.data?.version !== 3) throw new Error(`Day archive E2E failed: ${JSON.stringify(archivedDay)}`);
const archivedOccurrence = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ occurredOn: smokeToday, version: 3 }),
});
if (archivedOccurrence.response.status !== 409 || archivedOccurrence.payload?.error?.code !== "DAY_RECORD_ARCHIVED") throw new Error(`Day archived read-only E2E failed: ${archivedOccurrence.response.status} ${JSON.stringify(archivedOccurrence.payload)}`);
const restoredDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/restore`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 3 }),
}, 200);
if (restoredDay?.data?.status !== "active" || restoredDay?.data?.version !== 4) throw new Error(`Day restore E2E failed: ${JSON.stringify(restoredDay)}`);
const updatedDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 4, cycleDays: 31, attentionBeforeDays: 5 }),
}, 200);
if (updatedDay?.data?.version !== 5 || updatedDay?.data?.cycleDays !== 31 || updatedDay?.data?.nextDueDate !== addUtcDays(smokeToday, 31) || updatedDay?.data?.attentionBeforeDays !== 5) throw new Error(`Day update E2E failed: ${JSON.stringify(updatedDay)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}?version=5`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }, 204);
const deletedDay = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, { headers: { authorization: `Bearer ${accessToken}` } });
if (deletedDay.response.status !== 404 || deletedDay.payload?.error?.code !== "DAY_RECORD_NOT_FOUND") throw new Error(`Day soft-delete E2E failed: ${deletedDay.response.status} ${JSON.stringify(deletedDay.payload)}`);
console.log(`Phase 2.5 staging Day record E2E passed for ${spaceId} / ${dayRecordId}`);

const wishTitle = `Staging Smoke Wish ${smokeId}`;
const wish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ title: wishTitle, description: "Phase 2.6 staging E2E", desiredDate: "2099-07-01" }),
}, 201);
const wishId = wish?.data?.id;
if (!wishId) throw new Error("Core did not return a Wish id");
if (wish.data?.spaceId !== spaceId || wish.data?.status !== "open" || wish.data?.owner?.personId !== ownerPersonId || wish.data?.claimant !== null || wish.data?.fulfilledBy !== null || wish.data?.version !== 1) throw new Error(`Unexpected created Wish shape: ${JSON.stringify(wish)}`);
const wishList = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes?ownerPersonId=me&desiredFrom=2099-01-01&desiredTo=2099-12-31&sort=desired_asc`, { headers: { authorization: `Bearer ${accessToken}` } }, 200);
if (wishList?.data?.items?.length !== 1 || wishList.data.items[0]?.id !== wishId) throw new Error(`Wish list/owner/date E2E failed: ${JSON.stringify(wishList)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes`, {}, 401);
const ownClaim = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}/claim`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1 }),
});
if (ownClaim.response.status !== 409 || ownClaim.payload?.error?.code !== "WISH_CANNOT_CLAIM_OWN") throw new Error(`Wish own-claim E2E failed: ${ownClaim.response.status} ${JSON.stringify(ownClaim.payload)}`);
const staleWish = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 999, title: "stale update" }),
});
if (staleWish.response.status !== 409 || staleWish.payload?.error?.code !== "VERSION_CONFLICT") throw new Error(`Wish optimistic-concurrency E2E failed: ${staleWish.response.status} ${JSON.stringify(staleWish.payload)}`);
const fulfilledWish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}/fulfill`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1 }),
}, 200);
if (fulfilledWish?.data?.status !== "fulfilled" || fulfilledWish?.data?.fulfilledBy?.personId !== ownerPersonId || fulfilledWish?.data?.version !== 2) throw new Error(`Wish fulfill E2E failed: ${JSON.stringify(fulfilledWish)}`);
const reopenedWish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}/reopen`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 2 }),
}, 200);
if (reopenedWish?.data?.status !== "open" || reopenedWish?.data?.claimant !== null || reopenedWish?.data?.fulfilledBy !== null || reopenedWish?.data?.fulfilledAt !== null || reopenedWish?.data?.version !== 3) throw new Error(`Wish reopen E2E failed: ${JSON.stringify(reopenedWish)}`);
const archivedWish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}/archive`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 3 }),
}, 200);
if (archivedWish?.data?.status !== "archived" || archivedWish?.data?.version !== 4) throw new Error(`Wish archive E2E failed: ${JSON.stringify(archivedWish)}`);
const archivedWishEdit = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 4, title: "must not edit" }),
});
if (archivedWishEdit.response.status !== 409 || archivedWishEdit.payload?.error?.code !== "WISH_ARCHIVED") throw new Error(`Wish archived read-only E2E failed: ${archivedWishEdit.response.status} ${JSON.stringify(archivedWishEdit.payload)}`);
const restoredWish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}/restore`, {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 4 }),
}, 200);
if (restoredWish?.data?.status !== "open" || restoredWish?.data?.version !== 5) throw new Error(`Wish restore E2E failed: ${JSON.stringify(restoredWish)}`);
const updatedWish = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}`, {
  method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ version: 5, title: `${wishTitle} updated`, desiredDate: null }),
}, 200);
if (updatedWish?.data?.title !== `${wishTitle} updated` || updatedWish?.data?.desiredDate !== null || updatedWish?.data?.version !== 6) throw new Error(`Wish update E2E failed: ${JSON.stringify(updatedWish)}`);
await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}?version=6`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }, 204);
const deletedWish = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/wishes/${wishId}`, { headers: { authorization: `Bearer ${accessToken}` } });
if (deletedWish.response.status !== 404 || deletedWish.payload?.error?.code !== "WISH_NOT_FOUND") throw new Error(`Wish soft-delete E2E failed: ${deletedWish.response.status} ${JSON.stringify(deletedWish.payload)}`);
console.log(`Phase 2.6 staging Wish E2E passed for ${spaceId} / ${wishId}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## LifeSpace staging runtime\n\n- Bootstrap secret: synchronized and activated from GitHub staging secret\n- RS256 signing keys: ${rotatedSigningKeys ? "repaired and activated" : "existing active pair preserved"}\n- Identity -> token -> Core -> Space smoke test: passed\n- Core schema/contract: v7 / 0.8.0\n- Retired HomeMew runtime route 404 check: passed\n- Event create/list/filter/update/soft-delete E2E: passed\n- Task create/read/list/filter/assignee E2E: passed\n- Task optimistic concurrency + complete/reopen/update E2E: passed\n- Task includeNoDue native semantics: passed\n- Task soft deletion: passed\n- Day record create/read/list/subject E2E: passed\n- Day occurrence history + anchor advancement E2E: passed\n- Day optimistic concurrency + archive/restore/update E2E: passed\n- Day soft deletion: passed\n- Wish create/read/list/owner/date E2E: passed\n- Wish optimistic concurrency + fulfill/reopen/archive/restore/update E2E: passed\n- Wish own-claim protection + soft deletion: passed\n- Authentication deny checks: passed\n- Smoke Space: \`${spaceId}\`\n- Smoke Event: \`${eventId}\`\n- Smoke Task: \`${taskId}\`\n- Smoke Day record: \`${dayRecordId}\`\n- Smoke Wish: \`${wishId}\`\n`,
  );
}