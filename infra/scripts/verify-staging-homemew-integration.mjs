import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const smokeSpaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));
const verifierSuffix = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z]/gu, "").slice(-12);

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: smokeSpaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

const application = profile.application;
const applicationId = application.stagingId;
const allowedScopes = application.allowedUserScopes;
const forbiddenScopes = application.forbiddenUserScopes;
const modelAccess = profile.modelAccess;
const modelRoutes = {
  task: "tasks",
  wish: "wishes",
  day_record: "day-records",
  event: "events",
};

if (!applicationId || application.clientType !== "mini_program" || application.trustedBackend !== true) {
  throw new Error("HomeMew integration profile contains an invalid staging application definition");
}
if (!Array.isArray(allowedScopes) || !allowedScopes.length || allowedScopes.includes("models:manage")) {
  throw new Error("HomeMew integration profile must define product scopes without models:manage");
}
if (!Array.isArray(forbiddenScopes) || !forbiddenScopes.includes("models:manage")) {
  throw new Error("HomeMew integration profile must explicitly forbid models:manage");
}
if (Object.keys(modelAccess).some((key) => !(key in modelRoutes))) {
  throw new Error("HomeMew integration profile contains an unknown proving model key");
}
if (Object.values(modelAccess).some((access) => access !== "write")) {
  throw new Error("HomeMew proving models must currently be configured with write access");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runCoreSql(sql) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--json", `--command=${sql}`],
    { cwd: CORE_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) throw new Error(`Core staging D1 mutation failed: ${output}`);
  return entries;
}

async function jsonRequest(base, path, { method = "GET", bootstrap, bearer, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bootstrap ? { "x-bootstrap-secret": bootstrap } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Identity returned a malformed JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function expectStatus(label, result, expectedStatus, expectedCode = null) {
  if (
    result.response.status !== expectedStatus
    || (expectedCode && result.payload?.error?.code !== expectedCode)
  ) {
    throw new Error(`${label}: expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

const applicationPath = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
let metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
let credentialId = "";
let applicationSecret = "";
let userBearer = "";
let spaceId = "";
let familySpaceVersion = 0;
let taskId = "";
let taskVersion = 0;
let eventId = "";
let eventVersion = 0;
let verificationSucceeded = false;
const cleanupErrors = [];

if (metadata.response.status === 404) {
  const created = await jsonRequest(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: bootstrapSecret,
    body: {
      id: applicationId,
      name: "HomeMew staging",
      clientType: application.clientType,
      allowedScopes,
      trustedBackend: true,
      accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    },
  });
  applicationSecret = created.payload?.data?.clientSecret ?? "";
  if (created.response.status !== 201 || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`HomeMew staging application creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  mask(applicationSecret);
  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  const active = credentials.payload?.data?.filter((item) => item.status === "active" && item.revokedAt === null) ?? [];
  if (credentials.response.status !== 200 || active.length !== 1) {
    throw new Error(`Could not identify initial HomeMew staging credential: ${credentials.response.status} ${JSON.stringify(credentials.payload)}`);
  }
  credentialId = active[0].id;
} else if (metadata.response.status === 200) {
  const updated = await jsonRequest(identityBase, applicationPath, {
    method: "PATCH",
    bootstrap: bootstrapSecret,
    body: {
      name: "HomeMew staging",
      allowedScopes,
      accessTokenTtlSeconds: application.accessTokenTtlSeconds,
      status: "active",
    },
  });
  if (updated.response.status !== 200) {
    throw new Error(`HomeMew staging application policy update failed: ${updated.response.status} ${JSON.stringify(updated.payload)}`);
  }
  const replacement = await jsonRequest(identityBase, `${applicationPath}/credentials`, {
    method: "POST",
    bootstrap: bootstrapSecret,
  });
  credentialId = replacement.payload?.data?.id ?? "";
  applicationSecret = replacement.payload?.data?.clientSecret ?? "";
  if (replacement.response.status !== 201 || !credentialId.startsWith("apc_") || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`HomeMew staging verifier credential creation failed: ${replacement.response.status} ${JSON.stringify(replacement.payload)}`);
  }
  mask(applicationSecret);
} else {
  throw new Error(`HomeMew staging application lookup failed: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
}

try {
  metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
  const current = metadata.payload?.data;
  if (
    metadata.response.status !== 200
    || current?.id !== applicationId
    || current?.clientType !== application.clientType
    || current?.trustedBackend !== true
    || current?.accessTokenTtlSeconds !== application.accessTokenTtlSeconds
    || !Array.isArray(current?.allowedScopes)
    || !sameSet(current.allowedScopes, allowedScopes)
    || current.allowedScopes.includes("models:manage")
  ) {
    throw new Error(`HomeMew staging application metadata does not match the profile: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
  }

  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  if (credentials.response.status !== 200 || !Array.isArray(credentials.payload?.data)) {
    throw new Error(`HomeMew application credential metadata lookup failed: ${credentials.response.status} ${JSON.stringify(credentials.payload)}`);
  }
  if (credentials.payload.data.some((item) => "clientSecret" in item || "secretHash" in item)) {
    throw new Error("HomeMew application credential metadata leaked plaintext or hash fields");
  }

  const tokenResult = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
    method: "POST",
    bearer: applicationSecret,
    body: { subjectId: userId, scopes: allowedScopes },
  });
  userBearer = tokenResult.payload?.data?.accessToken ?? "";
  if (tokenResult.response.status !== 200 || !userBearer) {
    throw new Error(`HomeMew user-token exchange failed: ${tokenResult.response.status} ${JSON.stringify(tokenResult.payload)}`);
  }
  mask(userBearer);

  const claims = decodeJwtPayload(userBearer);
  const tokenScopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/u).filter(Boolean) : [];
  if (
    claims.azp !== applicationId
    || claims.sub !== userId
    || claims.principal_type !== "user"
    || !sameSet(tokenScopes, allowedScopes)
    || tokenScopes.includes("models:manage")
    || claims.exp - claims.iat !== application.accessTokenTtlSeconds
    || tokenResult.payload?.data?.expiresIn !== application.accessTokenTtlSeconds
  ) {
    throw new Error(`HomeMew user token does not match the integration profile: ${JSON.stringify({ claims, response: tokenResult.payload?.data })}`);
  }

  for (const forbiddenScope of forbiddenScopes) {
    const denied = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
      method: "POST",
      bearer: applicationSecret,
      body: { subjectId: userId, scopes: [...allowedScopes, forbiddenScope] },
    });
    if (denied.response.status !== 403) {
      throw new Error(`HomeMew scope ceiling did not reject ${forbiddenScope}: ${denied.response.status} ${JSON.stringify(denied.payload)}`);
    }
  }

  const profileRead = await jsonRequest(identityBase, "/api/v1/me", { bearer: userBearer });
  if (profileRead.response.status !== 200 || profileRead.payload?.data?.id !== userId) {
    throw new Error(`HomeMew-scoped token could not read Identity profile: ${profileRead.response.status} ${JSON.stringify(profileRead.payload)}`);
  }

  const now = new Date().toISOString();
  runCoreSql(`DELETE FROM application_model_access WHERE application_id=${sqlString(applicationId)}`);
  const accessValues = Object.entries(modelAccess)
    .map(([modelKey, maxAccess]) => `(${sqlString(applicationId)},${sqlString(modelKey)},${sqlString(maxAccess)},'user',${sqlString(userId)},${sqlString(now)},${sqlString(now)})`)
    .join(",");
  runCoreSql(`INSERT INTO application_model_access(
    application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
  ) VALUES ${accessValues}`);

  const coreMe = await jsonRequest(coreBase, "/api/v1/me", { bearer: userBearer });
  if (coreMe.response.status !== 200) {
    throw new Error(`HomeMew-scoped token could not reach Core /me: ${coreMe.response.status} ${JSON.stringify(coreMe.payload)}`);
  }

  const familyCreated = await jsonRequest(coreBase, "/api/v1/spaces", {
    method: "POST",
    bearer: userBearer,
    body: {
      kind: "family",
      name: `M3 HomeMew family ${verifierSuffix}`,
      ownerDisplayName: "M3 HomeMew Owner",
      timezone: "UTC",
    },
  });
  const familySpaceData = expectStatus("HomeMew family Space create", familyCreated, 201);
  spaceId = familySpaceData?.id ?? "";
  familySpaceVersion = familySpaceData?.version ?? 0;
  if (
    !spaceId
    || familySpaceData?.kind !== "family"
    || familySpaceData?.role !== "owner"
    || !familySpaceData?.ownerPersonId
    || familySpaceVersion !== 1
  ) {
    throw new Error(`HomeMew family Space create returned unexpected semantics: ${JSON.stringify(familySpaceData)}`);
  }

  const members = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/members`, { bearer: userBearer });
  const memberData = expectStatus("HomeMew family member resolution", members, 200);
  const ownerMember = Array.isArray(memberData) ? memberData.find((member) => member.userId === userId) : null;
  if (
    !ownerMember
    || ownerMember.role !== "owner"
    || ownerMember.personId !== familySpaceData.ownerPersonId
    || ownerMember.displayName !== "M3 HomeMew Owner"
  ) {
    throw new Error(`HomeMew family owner membership/person mapping is not explainable: ${JSON.stringify(memberData)}`);
  }

  const familyRead = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}`, { bearer: userBearer });
  const familyReadData = expectStatus("HomeMew family Space read", familyRead, 200);
  if (familyReadData?.id !== spaceId || familyReadData?.kind !== "family" || familyReadData?.access !== "owner") {
    throw new Error(`HomeMew family Space read returned unexpected authority: ${JSON.stringify(familyReadData)}`);
  }

  const modelResults = {};
  for (const [modelKey, maxAccess] of Object.entries(modelAccess)) {
    const route = modelRoutes[modelKey];
    const result = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}?limit=1`, { bearer: userBearer });
    if (result.response.status !== 200 || !Array.isArray(result.payload?.data?.items)) {
      throw new Error(`HomeMew model access failed for ${modelKey}: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    modelResults[modelKey] = maxAccess;
  }

  const eventCreated = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events`, {
    method: "POST",
    bearer: userBearer,
    body: {
      summary: `M3 HomeMew event ${verifierSuffix}`,
      isAllDay: true,
      startDate: "2099-01-01",
      endDateExclusive: "2099-01-02",
    },
  });
  const eventCreatedData = expectStatus("HomeMew Event create", eventCreated, 201);
  eventId = eventCreatedData?.id ?? "";
  eventVersion = eventCreatedData?.version ?? 0;
  if (!eventId || eventVersion !== 1 || eventCreatedData?.status !== "active") {
    throw new Error(`HomeMew Event create returned unexpected semantics: ${JSON.stringify(eventCreatedData)}`);
  }

  const eventRead = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, { bearer: userBearer });
  const eventReadData = expectStatus("HomeMew Event read", eventRead, 200);
  if (eventReadData?.id !== eventId || eventReadData?.summary !== `M3 HomeMew event ${verifierSuffix}`) {
    throw new Error(`HomeMew Event read did not return the created record: ${JSON.stringify(eventReadData)}`);
  }

  const eventUpdated = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    bearer: userBearer,
    body: { version: eventVersion, summary: `M3 HomeMew event updated ${verifierSuffix}`, location: "staging-only" },
  });
  const eventUpdatedData = expectStatus("HomeMew Event update", eventUpdated, 200);
  eventVersion = eventUpdatedData?.version ?? 0;
  if (eventVersion !== 2 || eventUpdatedData?.summary !== `M3 HomeMew event updated ${verifierSuffix}`) {
    throw new Error(`HomeMew Event update returned unexpected semantics: ${JSON.stringify(eventUpdatedData)}`);
  }

  const taskCreated = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks`, {
    method: "POST",
    bearer: userBearer,
    body: { name: `M3 HomeMew task ${verifierSuffix}` },
  });
  const taskCreatedData = expectStatus("HomeMew Task create", taskCreated, 201);
  taskId = taskCreatedData?.id ?? "";
  taskVersion = taskCreatedData?.version ?? 0;
  if (!taskId || taskVersion !== 1 || taskCreatedData?.status !== "pending") {
    throw new Error(`HomeMew Task create did not apply authoritative pending default: ${JSON.stringify(taskCreatedData)}`);
  }

  const taskRead = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}`, { bearer: userBearer });
  const taskReadData = expectStatus("HomeMew Task read", taskRead, 200);
  if (taskReadData?.id !== taskId || taskReadData?.status !== "pending") {
    throw new Error(`HomeMew Task read did not return the created record: ${JSON.stringify(taskReadData)}`);
  }

  const taskUpdated = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    bearer: userBearer,
    body: { version: taskVersion, name: `M3 HomeMew task updated ${verifierSuffix}`, dueDate: "2099-01-03" },
  });
  const taskUpdatedData = expectStatus("HomeMew Task update", taskUpdated, 200);
  taskVersion = taskUpdatedData?.version ?? 0;
  if (taskVersion !== 2 || taskUpdatedData?.name !== `M3 HomeMew task updated ${verifierSuffix}`) {
    throw new Error(`HomeMew Task update returned unexpected semantics: ${JSON.stringify(taskUpdatedData)}`);
  }

  const staleComplete = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}/actions/complete`, {
    method: "POST",
    bearer: userBearer,
    body: { version: 1 },
  });
  expectStatus("HomeMew Task stale Action", staleComplete, 409, "VERSION_CONFLICT");

  const taskCompleted = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}/actions/complete`, {
    method: "POST",
    bearer: userBearer,
    body: { version: taskVersion },
  });
  const taskCompletedData = expectStatus("HomeMew Task complete Action", taskCompleted, 200);
  taskVersion = taskCompletedData?.version ?? 0;
  if (
    taskVersion !== 3
    || taskCompletedData?.status !== "completed"
    || taskCompletedData?.completedByType !== "user"
    || taskCompletedData?.completedById !== userId
  ) {
    throw new Error(`HomeMew Task complete Action returned unexpected attribution: ${JSON.stringify(taskCompletedData)}`);
  }

  const taskChanges = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/changes/${encodeURIComponent(taskId)}`, { bearer: userBearer });
  const taskChangesData = expectStatus("HomeMew Task Change History", taskChanges, 200);
  const actionChange = taskChangesData?.items?.find?.((change) => change.operation === "action" && change.versionAfter === taskVersion);
  if (
    !actionChange
    || actionChange.applicationId !== applicationId
    || actionChange.principal?.type !== "user"
    || actionChange.principal?.id !== userId
    || actionChange.actor?.type !== "user"
    || actionChange.actor?.id !== userId
    || actionChange.delegationId !== null
  ) {
    throw new Error(`HomeMew Task Change attribution is not explainable: ${JSON.stringify(taskChangesData)}`);
  }

  const eventDeleted = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    bearer: userBearer,
    body: { version: eventVersion },
  });
  expectStatus("HomeMew Event delete", eventDeleted, 204);
  eventId = "";
  eventVersion = 0;

  const taskDeleted = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    bearer: userBearer,
    body: { version: taskVersion },
  });
  expectStatus("HomeMew Task delete", taskDeleted, 204);
  taskId = "";
  taskVersion = 0;

  verificationSucceeded = true;
  console.log(JSON.stringify({
    ok: true,
    applicationId,
    clientType: application.clientType,
    accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    allowedUserScopes: allowedScopes,
    forbiddenScopeRejection: forbiddenScopes,
    tokenApplicationBinding: claims.azp,
    modelAccess: modelResults,
    identityProfileRead: true,
    coreMembershipContextRead: true,
    genericSmokeSpaceKindNotAssumed: smokeSpaceId !== spaceId,
    familySpaceKindVerified: true,
    familyOwnerMembershipResolved: true,
    goldenFlow: {
      eventCrud: true,
      taskCrud: true,
      taskSemanticAction: true,
      staleVersionDenied: true,
      governedChangeAttribution: true,
    },
    credentialMetadataRedacted: true,
    productionUntouched: true,
  }, null, 2));
} finally {
  async function cleanup(label, action) {
    try { await action(); }
    catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (taskId && taskVersion && userBearer && spaceId) {
    await cleanup("Task cleanup", async () => {
      const result = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        bearer: userBearer,
        body: { version: taskVersion },
      });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
    });
  }
  if (eventId && eventVersion && userBearer && spaceId) {
    await cleanup("Event cleanup", async () => {
      const result = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        bearer: userBearer,
        body: { version: eventVersion },
      });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
    });
  }
  if (spaceId && familySpaceVersion && userBearer) {
    await cleanup("HomeMew family Space close", async () => {
      const result = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/close`, {
        method: "POST",
        bearer: userBearer,
        body: { version: familySpaceVersion },
      });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
    });
  }
  if (credentialId) {
    await cleanup("HomeMew staging verifier credential cleanup", async () => {
      const revoke = await jsonRequest(identityBase, `${applicationPath}/credentials/${encodeURIComponent(credentialId)}`, {
        method: "DELETE",
        bootstrap: bootstrapSecret,
      });
      if (revoke.response.status !== 204 && revoke.response.status !== 404) {
        throw new Error(`HTTP ${revoke.response.status} ${JSON.stringify(revoke.payload)}`);
      }
    });
  }

  if (cleanupErrors.length) {
    if (verificationSucceeded) throw new Error(`HomeMew staging verifier cleanup failed: ${cleanupErrors.join(" | ")}`);
    console.error(`HomeMew staging verifier cleanup warnings: ${cleanupErrors.join(" | ")}`);
  }
}
