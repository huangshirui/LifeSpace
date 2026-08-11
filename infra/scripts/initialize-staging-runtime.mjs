import { generateKeyPairSync } from "node:crypto";
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
    BOOTSTRAP_SECRET: bootstrapSecret,
  });
  await wranglerSecretBulk("apps/core", {
    IDENTITY_PUBLIC_KEY: publicKey,
  });
  console.log("Generated, installed, and activated a new staging RS256 signing key pair");
}

// Always synchronize the persistent bootstrap credential using Wrangler's
// non-versioned secret command so the resulting Worker version is deployed
// immediately. This repairs any earlier secret-only version that was not active.
await wranglerSecretBulk("apps/identity", {
  BOOTSTRAP_SECRET: bootstrapSecret,
});
console.log("Staging bootstrap secret synchronized and activated");

const appId = `app_staging_smoke_${smokeId}`;
const displayName = `Staging Smoke ${smokeId}`;
const scopes = [
  "profile:read",
  "spaces:read",
  "spaces:write",
  "tasks:read",
  "tasks:write",
  "day-records:read",
  "day-records:write",
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

let rotatedSigningKeys = false;
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

const coreStatus = await requestJson(`${coreBase}/api/v1/status`, {}, 200);
if (
  coreStatus?.data?.environment !== "staging"
  || coreStatus?.data?.schemaVersion !== "6"
  || coreStatus?.data?.contractVersion !== "0.6.0"
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

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
}, 200);

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {}, 401);

const taskName = `Staging Smoke Task ${smokeId}`;
const task = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
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
  task.data?.spaceId !== spaceId
  || task.data?.status !== "pending"
  || task.data?.dueDate !== "2099-12-31"
  || task.data?.version !== 1
  || task.data?.assignees?.length !== 1
  || task.data?.assignees?.[0]?.personId !== ownerPersonId
) {
  throw new Error(`Unexpected created Task shape: ${JSON.stringify(task)}`);
}

const taskList = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&q=${encodeURIComponent(taskName)}`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (taskList?.data?.items?.length !== 1 || taskList.data.items[0]?.id !== taskId) {
  throw new Error(`Task list/filter E2E failed: ${JSON.stringify(taskList)}`);
}

const taskRead = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
}, 200);
if (taskRead?.data?.id !== taskId || taskRead?.data?.assignees?.[0]?.personId !== ownerPersonId) {
  throw new Error(`Task read/assignee E2E failed: ${JSON.stringify(taskRead)}`);
}

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks`, {}, 401);

const staleUpdate = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  method: "PATCH",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 999, description: "stale update must fail" }),
});
if (staleUpdate.response.status !== 409 || staleUpdate.payload?.error?.code !== "TASK_VERSION_CONFLICT") {
  throw new Error(`Task optimistic-concurrency E2E failed: ${staleUpdate.response.status} ${JSON.stringify(staleUpdate.payload)}`);
}

const completedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}/complete`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 1 }),
}, 200);
if (
  completedTask?.data?.status !== "completed"
  || completedTask?.data?.version !== 2
  || completedTask?.data?.completedBy?.id !== userId
) {
  throw new Error(`Task complete E2E failed: ${JSON.stringify(completedTask)}`);
}

const reopenedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}/reopen`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 2 }),
}, 200);
if (
  reopenedTask?.data?.status !== "pending"
  || reopenedTask?.data?.version !== 3
  || reopenedTask?.data?.completedAt !== null
  || reopenedTask?.data?.completedBy !== null
) {
  throw new Error(`Task reopen E2E failed: ${JSON.stringify(reopenedTask)}`);
}

const updatedTask = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  method: "PATCH",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    version: 3,
    description: "Phase 2.4 staging E2E updated",
    dueDate: null,
    assigneePersonIds: [ownerPersonId],
  }),
}, 200);
if (
  updatedTask?.data?.version !== 4
  || updatedTask?.data?.description !== "Phase 2.4 staging E2E updated"
  || updatedTask?.data?.dueDate !== null
  || updatedTask?.data?.assignees?.[0]?.personId !== ownerPersonId
) {
  throw new Error(`Task update E2E failed: ${JSON.stringify(updatedTask)}`);
}

const withoutNoDue = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&dueDateFrom=2099-01-01&q=${encodeURIComponent(taskName)}`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (withoutNoDue?.data?.items?.length !== 0) {
  throw new Error(`Task includeNoDue omission E2E failed: ${JSON.stringify(withoutNoDue)}`);
}

const withNoDue = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/tasks?assigneePersonId=me&dueDateFrom=2099-01-01&includeNoDue=true&q=${encodeURIComponent(taskName)}`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (withNoDue?.data?.items?.length !== 1 || withNoDue.data.items[0]?.id !== taskId) {
  throw new Error(`Task includeNoDue=true E2E failed: ${JSON.stringify(withNoDue)}`);
}

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}?version=4`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${accessToken}` },
}, 204);

const deletedTask = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/tasks/${taskId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
if (deletedTask.response.status !== 404 || deletedTask.payload?.error?.code !== "TASK_NOT_FOUND") {
  throw new Error(`Task soft-delete E2E failed: ${deletedTask.response.status} ${JSON.stringify(deletedTask.payload)}`);
}

console.log(`Phase 2.4 staging Task E2E passed for ${spaceId} / ${taskId}`);

const smokeToday = new Date().toISOString().slice(0, 10);
const dayAnchor = addUtcDays(smokeToday, -1);
const expectedNextDue = addUtcDays(smokeToday, 30);
const dayName = `Staging Smoke Day ${smokeId}`;
const dayRecord = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    name: dayName,
    description: "Phase 2.5 staging E2E",
    kind: "cycle",
    anchorDate: dayAnchor,
    cycleDays: 30,
    subjectPersonId: ownerPersonId,
  }),
}, 201);

const dayRecordId = dayRecord?.data?.id;
if (!dayRecordId) throw new Error("Core did not return a Day record id");
if (
  dayRecord.data?.spaceId !== spaceId
  || dayRecord.data?.kind !== "cycle"
  || dayRecord.data?.anchorDate !== dayAnchor
  || dayRecord.data?.nextDueDate !== addUtcDays(dayAnchor, 30)
  || dayRecord.data?.attentionBeforeDays !== 7
  || dayRecord.data?.status !== "active"
  || dayRecord.data?.version !== 1
  || dayRecord.data?.subject?.personId !== ownerPersonId
) {
  throw new Error(`Unexpected created Day record shape: ${JSON.stringify(dayRecord)}`);
}

const dayList = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/day-records?kind=cycle&subjectPersonId=me&sort=created_desc`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (dayList?.data?.items?.length !== 1 || dayList.data.items[0]?.id !== dayRecordId) {
  throw new Error(`Day record list/subject E2E failed: ${JSON.stringify(dayList)}`);
}

const initialOccurrences = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (
  initialOccurrences?.data?.items?.length !== 1
  || initialOccurrences.data.items[0]?.occurredOn !== dayAnchor
  || initialOccurrences.data.items[0]?.source !== "initial"
  || initialOccurrences.data.items[0]?.intervalDays !== null
) {
  throw new Error(`Day initial occurrence E2E failed: ${JSON.stringify(initialOccurrences)}`);
}

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records`, {}, 401);

const staleDayUpdate = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, {
  method: "PATCH",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 999, description: "stale update must fail" }),
});
if (staleDayUpdate.response.status !== 409 || staleDayUpdate.payload?.error?.code !== "DAY_RECORD_VERSION_CONFLICT") {
  throw new Error(`Day optimistic-concurrency E2E failed: ${staleDayUpdate.response.status} ${JSON.stringify(staleDayUpdate.payload)}`);
}

const occurrence = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ occurredOn: smokeToday, note: "Phase 2.5 staging occurrence", version: 1 }),
}, 201);
if (
  occurrence?.data?.previousAnchorDate !== dayAnchor
  || occurrence?.data?.intervalDays !== 1
  || occurrence?.data?.record?.anchorDate !== smokeToday
  || occurrence?.data?.record?.nextDueDate !== expectedNextDue
  || occurrence?.data?.record?.version !== 2
) {
  throw new Error(`Day occurrence/anchor E2E failed: ${JSON.stringify(occurrence)}`);
}

const occurrenceHistory = await requestJson(
  `${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`,
  { headers: { authorization: `Bearer ${accessToken}` } },
  200,
);
if (
  occurrenceHistory?.data?.items?.length !== 2
  || occurrenceHistory.data.items[0]?.occurredOn !== smokeToday
  || occurrenceHistory.data.items[0]?.source !== "manual"
  || occurrenceHistory.data.items[0]?.intervalDays !== 1
) {
  throw new Error(`Day occurrence history E2E failed: ${JSON.stringify(occurrenceHistory)}`);
}

const archivedDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/archive`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 2 }),
}, 200);
if (archivedDay?.data?.status !== "archived" || archivedDay?.data?.version !== 3) {
  throw new Error(`Day archive E2E failed: ${JSON.stringify(archivedDay)}`);
}

const archivedOccurrence = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/occurrences`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ occurredOn: smokeToday, version: 3 }),
});
if (archivedOccurrence.response.status !== 409 || archivedOccurrence.payload?.error?.code !== "DAY_RECORD_ARCHIVED") {
  throw new Error(`Day archived read-only E2E failed: ${archivedOccurrence.response.status} ${JSON.stringify(archivedOccurrence.payload)}`);
}

const restoredDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}/restore`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 3 }),
}, 200);
if (restoredDay?.data?.status !== "active" || restoredDay?.data?.version !== 4) {
  throw new Error(`Day restore E2E failed: ${JSON.stringify(restoredDay)}`);
}

const updatedDay = await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, {
  method: "PATCH",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ version: 4, cycleDays: 31, attentionBeforeDays: 5 }),
}, 200);
if (
  updatedDay?.data?.version !== 5
  || updatedDay?.data?.cycleDays !== 31
  || updatedDay?.data?.nextDueDate !== addUtcDays(smokeToday, 31)
  || updatedDay?.data?.attentionBeforeDays !== 5
) {
  throw new Error(`Day update E2E failed: ${JSON.stringify(updatedDay)}`);
}

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}?version=5`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${accessToken}` },
}, 204);

const deletedDay = await fetchJson(`${coreBase}/api/v1/spaces/${spaceId}/day-records/${dayRecordId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
if (deletedDay.response.status !== 404 || deletedDay.payload?.error?.code !== "DAY_RECORD_NOT_FOUND") {
  throw new Error(`Day soft-delete E2E failed: ${deletedDay.response.status} ${JSON.stringify(deletedDay.payload)}`);
}

console.log(`Phase 2.5 staging Day record E2E passed for ${spaceId} / ${dayRecordId}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## LifeSpace staging runtime\n\n- Bootstrap secret: synchronized and activated from GitHub staging secret\n- RS256 signing keys: ${rotatedSigningKeys ? "repaired and activated" : "existing active pair preserved"}\n- Identity -> token -> Core -> Space smoke test: passed\n- Core schema/contract: v6 / 0.6.0\n- Task create/read/list/filter/assignee E2E: passed\n- Task optimistic concurrency + complete/reopen/update E2E: passed\n- Task includeNoDue compatibility semantics: passed\n- Task soft deletion: passed\n- Day record create/read/list/subject E2E: passed\n- Day occurrence history + anchor advancement E2E: passed\n- Day optimistic concurrency + archive/restore/update E2E: passed\n- Day soft deletion: passed\n- Authentication deny checks: passed\n- Smoke Space: \`${spaceId}\`\n- Smoke Task: \`${taskId}\`\n- Smoke Day record: \`${dayRecordId}\`\n`,
  );
}
