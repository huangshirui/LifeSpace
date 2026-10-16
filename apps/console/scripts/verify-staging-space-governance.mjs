import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = (process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "").trim();
const applicationId = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging").trim();
const explicitAdminUserId = (process.env.LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID ?? "").trim();
const runSuffix = String(process.env.GITHUB_RUN_ID ?? Date.now()).replace(/\D/gu, "").slice(-18) || String(Date.now());
const executorName = "LifeSpace Console Core executor (staging)";
const executorScopes = ["spaces:inspect", "spaces:manage", "grants:manage", "audit:read"];

function assertStagingUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.includes("staging") || url.hostname === "core.aisr.online" || url.hostname === "auth.aisr.online") {
    throw new Error(`${label} must be an explicit staging HTTPS URL, got ${value}`);
  }
}

assertStagingUrl(identityBase, "Identity URL");
assertStagingUrl(coreBase, "Core URL");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("Console application id is invalid");
if (explicitAdminUserId && !/^usr_[0-9A-Za-z_-]+$/u.test(explicitAdminUserId)) throw new Error("Explicit platform admin user id is invalid");
console.log(`::add-mask::${bootstrapSecret}`);

async function request(base, path, { method = "GET", bootstrap = false, bearer = "", actor = "", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(actor ? { "x-lifespace-actor-token": actor } : {}),
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

function requireStatus(result, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.response.status)) {
    throw new Error(`${label} expected HTTP ${allowed.join("/")}, got ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

function requireItemList(data, label) {
  if (!data || !Array.isArray(data.items)) throw new Error(`${label} did not return an items array`);
  return data.items;
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

async function resolveAdminUserId() {
  if (explicitAdminUserId) return explicitAdminUserId;
  const result = await request(identityBase, "/bootstrap/v1/platform-administrators", { bootstrap: true });
  const rows = requireStatus(result, 200, "List platform administrators");
  const active = Array.isArray(rows) ? rows.filter((entry) => entry?.status === "active" && entry?.userStatus === "active") : [];
  if (active.length !== 1 || typeof active[0]?.userId !== "string") {
    throw new Error(`Expected exactly one active staging platform administrator, found ${active.length}`);
  }
  return active[0].userId;
}

const cleanup = {
  applicationCredentialId: "",
  applicationCredential: "",
  principalId: "",
  serviceTokenId: "",
  serviceToken: "",
  actorToken: "",
  grantId: "",
  targetSpaceId: "",
  grantRevoked: false,
};

let adminUserId = "";

async function core(path, options = {}) {
  return request(coreBase, path, {
    ...options,
    bearer: cleanup.serviceToken,
    actor: cleanup.actorToken,
  });
}

async function cleanupGrant() {
  if (!cleanup.grantId || !cleanup.targetSpaceId || cleanup.grantRevoked || !cleanup.serviceToken || !cleanup.actorToken) return;
  const result = await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/grants/${encodeURIComponent(cleanup.grantId)}`, {
    method: "DELETE",
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Temporary Data Grant cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  cleanup.grantRevoked = true;
}

async function cleanupCredentials() {
  if (cleanup.serviceTokenId && cleanup.principalId && cleanup.applicationCredential) {
    const result = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens/${encodeURIComponent(cleanup.serviceTokenId)}`, {
      method: "DELETE",
      bearer: cleanup.applicationCredential,
    });
    if (result.response.status !== 204 && result.response.status !== 404) {
      throw new Error(`Temporary Core token revocation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    cleanup.serviceTokenId = "";
    cleanup.serviceToken = "";
  }
  if (cleanup.applicationCredentialId) {
    const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(cleanup.applicationCredentialId)}`, {
      method: "DELETE",
      bootstrap: true,
    });
    if (result.response.status !== 204 && result.response.status !== 404) {
      throw new Error(`Temporary application credential revocation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    cleanup.applicationCredentialId = "";
    cleanup.applicationCredential = "";
  }
}

async function findAdminManagedSpace() {
  const summaries = requireStatus(await core("/api/v1/platform-admin/spaces?limit=100"), 200, "List Spaces through Platform Admin");
  if (!Array.isArray(summaries) || !summaries.length) throw new Error("No staging Space is available for Platform Admin governance acceptance");
  for (const summary of summaries) {
    if (typeof summary?.id !== "string") continue;
    const detail = requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(summary.id)}`), 200, `Inspect Space ${summary.id}`);
    const member = Array.isArray(detail?.members)
      ? detail.members.find((entry) => entry?.userId === adminUserId && (entry?.role === "owner" || entry?.role === "admin"))
      : null;
    if (member) return detail;
  }
  throw new Error(`No staging Space managed by platform administrator ${adminUserId} is available for a redundant Grant acceptance`);
}

let primaryError = null;
try {
  const [identityStatus, coreStatus] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  const identityData = requireStatus(identityStatus, 200, "Identity staging status");
  const coreData = requireStatus(coreStatus, 200, "Core staging status");
  if (identityData?.environment !== "staging" || coreData?.environment !== "staging") {
    throw new Error("Refusing to run Space governance acceptance outside staging");
  }

  adminUserId = await resolveAdminUserId();

  const app = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
  const appData = requireStatus(app, 200, "Load Console application");
  const requiredScopes = ["profile:read", "platform:admin", "services:manage", ...executorScopes];
  const missingScopes = requiredScopes.filter((scope) => !appData?.allowedScopes?.includes(scope));
  if (appData?.trustedBackend !== true || appData?.status !== "active" || missingScopes.length) {
    throw new Error(`Console application is not ready for Space governance acceptance: missing scopes ${missingScopes.join(",") || "none"}`);
  }

  const credential = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, {
    method: "POST",
    bootstrap: true,
  });
  const credentialData = requireStatus(credential, 201, "Create temporary Console application credential");
  cleanup.applicationCredentialId = credentialData.id;
  cleanup.applicationCredential = credentialData.clientSecret;
  if (!cleanup.applicationCredentialId || !cleanup.applicationCredential?.startsWith("lsa_")) throw new Error("Temporary Console application credential is invalid");
  mask(cleanup.applicationCredential);

  const principals = await request(identityBase, "/api/v1/service-principals", { bearer: cleanup.applicationCredential });
  const principalRows = requireStatus(principals, 200, "List Console service principals");
  const matches = Array.isArray(principalRows) ? principalRows.filter((entry) => entry?.displayName === executorName && entry?.status === "active") : [];
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") throw new Error(`Expected one active Console Core executor, found ${matches.length}`);
  cleanup.principalId = matches[0].id;

  const tempToken = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens`, {
    method: "POST",
    bearer: cleanup.applicationCredential,
    body: {
      label: `Console Space governance acceptance ${runSuffix}`,
      scopes: executorScopes,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdByUserId: adminUserId,
    },
  });
  const tokenData = requireStatus(tempToken, 201, "Create temporary Core executor token");
  cleanup.serviceTokenId = tokenData.id;
  cleanup.serviceToken = tokenData.token;
  if (!cleanup.serviceTokenId || !cleanup.serviceToken?.startsWith("lsp_svc_")) throw new Error("Temporary Core token is invalid");
  mask(cleanup.serviceToken);

  const userTokenResult = await request(identityBase, "/internal/v1/tokens", {
    method: "POST",
    bearer: cleanup.applicationCredential,
    body: { subjectId: adminUserId, scopes: ["profile:read"] },
  });
  const userTokenData = requireStatus(userTokenResult, 200, "Issue temporary Console user token");
  const userToken = userTokenData.accessToken;
  if (typeof userToken !== "string" || userToken.split(".").length !== 3) throw new Error("Temporary Console user token is invalid");
  mask(userToken);

  const actorResult = await request(identityBase, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    bearer: userToken,
  });
  const actorData = requireStatus(actorResult, 200, "Issue platform-admin actor proof");
  cleanup.actorToken = actorData.actorToken;
  if (typeof cleanup.actorToken !== "string" || cleanup.actorToken.split(".").length !== 3) throw new Error("Platform-admin actor proof is invalid");
  mask(cleanup.actorToken);

  const target = await findAdminManagedSpace();
  cleanup.targetSpaceId = target.id;
  if (typeof cleanup.targetSpaceId !== "string") throw new Error("Selected staging Space has no id");

  const existingExecutorGrant = Array.isArray(target.grants)
    ? target.grants.find((entry) => entry?.granteeType === "service" && entry?.granteeId === cleanup.principalId && !entry?.revokedAt)
    : null;
  if (existingExecutorGrant) {
    throw new Error(`Console Core executor unexpectedly has an active Data Grant in ${cleanup.targetSpaceId}: ${existingExecutorGrant.id}`);
  }

  const ordinaryGrantProbe = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/grants`, {
    bearer: cleanup.serviceToken,
  });
  requireStatus(ordinaryGrantProbe, 403, "Deny Console service executor on ordinary User Data Grant API");

  const ordinaryExternalProbe = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/external-connections`, {
    bearer: cleanup.serviceToken,
  });
  requireStatus(ordinaryExternalProbe, 403, "Deny Console service executor on ordinary User External API");

  const platformConnections = requireItemList(
    requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/external-connections`), 200, "List External Connections through Platform Admin"),
    "Platform Admin External Connections",
  );
  const platformBindings = requireItemList(
    requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/external-models`), 200, "List External Model bindings through Platform Admin"),
    "Platform Admin External Model bindings",
  );
  const platformDefinitions = requireItemList(
    requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/external-model-definitions`), 200, "List External Model Definitions through Platform Admin"),
    "Platform Admin External Model Definitions",
  );

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const created = requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/grants`, {
    method: "POST",
    body: {
      granteeType: "user",
      granteeId: adminUserId,
      resourceType: "space",
      permission: "read",
      expiresAt,
    },
  }), 201, "Create redundant staging Data Grant through Platform Admin");
  cleanup.grantId = created?.id ?? "";
  if (!/^grt_[A-Za-z0-9_-]+$/u.test(cleanup.grantId) || created?.permission !== "read" || created?.granteeId !== adminUserId) {
    throw new Error(`Unexpected Data Grant create result: ${JSON.stringify(created)}`);
  }

  const updatedExpiry = new Date(Date.now() + 12 * 60 * 1000).toISOString();
  const updated = requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/grants/${encodeURIComponent(cleanup.grantId)}`, {
    method: "PATCH",
    body: { permission: "write", expiresAt: updatedExpiry },
  }), 200, "Update staging Data Grant through Platform Admin");
  if (updated?.id !== cleanup.grantId || updated?.permission !== "write" || updated?.expiresAt !== updatedExpiry) {
    throw new Error(`Unexpected Data Grant update result: ${JSON.stringify(updated)}`);
  }

  requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}/grants/${encodeURIComponent(cleanup.grantId)}`, {
    method: "DELETE",
  }), 204, "Revoke staging Data Grant through Platform Admin");
  cleanup.grantRevoked = true;

  const after = requireStatus(await core(`/api/v1/platform-admin/spaces/${encodeURIComponent(cleanup.targetSpaceId)}`), 200, "Inspect Space after Data Grant revoke");
  const revoked = Array.isArray(after?.grants) ? after.grants.find((entry) => entry?.id === cleanup.grantId) : null;
  if (!revoked?.revokedAt || revoked.permission !== "write") {
    throw new Error(`Revoked Data Grant evidence is missing from Space inspector: ${JSON.stringify(revoked)}`);
  }

  const auditData = requireStatus(await core("/api/v1/platform-admin/audit?limit=200"), 200, "Read platform-admin audit after Space governance acceptance");
  const auditRows = Array.isArray(auditData) ? auditData : [];
  const relevant = auditRows.filter((entry) => entry?.actorUserId === adminUserId && entry?.actorApplicationId === applicationId && entry?.targetId === cleanup.grantId && entry?.result === "success");
  const operations = new Set(relevant.map((entry) => entry?.operation));
  for (const operation of ["data_grant.create", "data_grant.update", "data_grant.revoke"]) {
    if (!operations.has(operation)) throw new Error(`Platform Admin audit is missing ${operation} for ${cleanup.grantId}`);
  }

  console.log(JSON.stringify({
    ok: true,
    environment: "staging",
    authority: "platform-admin",
    actorUserId: adminUserId,
    actorApplicationId: applicationId,
    targetSpaceId: cleanup.targetSpaceId,
    ordinaryUserApisRejectServiceExecutor: { grants: true, externalConnections: true },
    dataGrant: { id: cleanup.grantId, redundantForExistingSpaceAdmin: true, created: true, updated: true, revoked: true },
    externalGovernanceRead: {
      connections: platformConnections.length,
      bindings: platformBindings.length,
      definitions: platformDefinitions.length,
      platformAdminNamespace: true,
    },
    consoleExecutorHasNoTargetSpaceGrant: true,
    audit: { create: true, update: true, revoke: true },
    executorScopes,
    temporaryCredentials: { applicationCredentialRevokedInFinally: true, coreTokenRevokedInFinally: true },
    productionTouched: false,
  }, null, 2));
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  try { await cleanupGrant(); } catch (error) { cleanupErrors.push(error); }
  try { await cleanupCredentials(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    const detail = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    if (!primaryError) primaryError = new Error(`Space governance acceptance cleanup failed: ${detail}`);
    else console.error(`Space governance acceptance cleanup also failed: ${detail}`);
  }
}

if (primaryError) throw primaryError;
