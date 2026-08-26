import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = (process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "").trim();
const applicationId = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging").trim();
const explicitAdminUserId = (process.env.LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID ?? "").trim();
const runSuffix = String(process.env.GITHUB_RUN_ID ?? Date.now()).replace(/\D/gu, "").slice(-18) || String(Date.now());
const modelKey = `console_acceptance_${runSuffix}`.slice(0, 63);
const modelRoute = `console-acceptance-${runSuffix}`.slice(0, 63);
const executorName = "LifeSpace Console Core executor (staging)";
const executorScopes = ["applications:manage", "models:manage", "spaces:inspect", "audit:read"];

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

function definitionV1() {
  return {
    definitionVersion: 1,
    key: modelKey,
    route: modelRoute,
    description: "Ephemeral staging-only model used to verify the LifeSpace Console control-plane publication path.",
    display: { singular: "Console Acceptance", plural: "Console Acceptances" },
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 100 },
    },
    query: { searchable: ["title"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  };
}

function definitionV2() {
  return {
    ...definitionV1(),
    fields: {
      ...definitionV1().fields,
      note: { type: "text", nullable: true, maxLength: 500 },
    },
    query: { searchable: ["title", "note"], sortable: ["title"] },
  };
}

const cleanup = {
  applicationCredentialId: "",
  applicationCredential: "",
  principalId: "",
  serviceTokenId: "",
  serviceToken: "",
  actorToken: "",
  originalModelAccess: null,
  modelAccessChanged: false,
  modelPublished: false,
  modelRetired: false,
};

let adminUserId = "";

async function core(path, options = {}) {
  return request(coreBase, path, {
    ...options,
    bearer: cleanup.serviceToken,
    actor: cleanup.actorToken,
  });
}

async function restoreModelAccess() {
  if (!cleanup.modelAccessChanged || !Array.isArray(cleanup.originalModelAccess)) return;
  const result = await core(`/api/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/model-access`, {
    method: "PUT",
    body: { models: cleanup.originalModelAccess },
  });
  requireStatus(result, 200, "Restore Application × Model Access");
  cleanup.modelAccessChanged = false;
}

async function retireAcceptanceModel() {
  if (!cleanup.modelPublished || cleanup.modelRetired) return;
  const result = await core(`/api/v1/model-admin/models/${encodeURIComponent(modelKey)}/retire`, { method: "POST", body: {} });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Cleanup retirement failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  cleanup.modelRetired = true;
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

let primaryError = null;
try {
  const [identityStatus, coreStatus] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  const identityData = requireStatus(identityStatus, 200, "Identity staging status");
  const coreData = requireStatus(coreStatus, 200, "Core staging status");
  if (identityData?.environment !== "staging" || coreData?.environment !== "staging") {
    throw new Error("Refusing to run Console acceptance outside staging");
  }

  adminUserId = await resolveAdminUserId();

  const app = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
  const appData = requireStatus(app, 200, "Load Console application");
  const requiredScopes = ["profile:read", "platform:admin", "services:manage", ...executorScopes];
  const missingScopes = requiredScopes.filter((scope) => !appData?.allowedScopes?.includes(scope));
  if (appData?.trustedBackend !== true || appData?.status !== "active" || missingScopes.length) {
    throw new Error(`Console application is not ready for acceptance: missing scopes ${missingScopes.join(",") || "none"}`);
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
      label: `Console staging acceptance ${runSuffix}`,
      scopes: executorScopes,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdByUserId: adminUserId,
    },
  });
  const tokenData = requireStatus(tempToken, 201, "Create temporary Core executor token");
  cleanup.serviceTokenId = tokenData.id;
  cleanup.serviceToken = tokenData.token;
  if (!cleanup.serviceTokenId || !cleanup.serviceToken?.startsWith("lsp_pat_")) throw new Error("Temporary Core token is invalid");
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

  const principal = await core("/api/v1/me");
  const principalData = requireStatus(principal, 200, "Authenticate temporary Core executor");
  if (principalData?.principal?.type !== "service" || principalData?.principal?.clientId !== applicationId) {
    throw new Error(`Temporary Core executor resolved to unexpected principal: ${JSON.stringify(principalData?.principal)}`);
  }

  const beforeContract = requireStatus(await core("/api/v1/model-admin/contracts/active"), 200, "Read active Model Contract before acceptance");

  const validation = requireStatus(await core("/api/v1/model-admin/models/validate", {
    method: "POST",
    body: { definition: definitionV1() },
  }), 200, "Validate acceptance Model Definition");
  if (validation?.valid !== true) throw new Error(`Acceptance Model Definition did not validate: ${JSON.stringify(validation)}`);

  const publishedV1 = requireStatus(await core("/api/v1/model-admin/models", {
    method: "POST",
    body: { definition: definitionV1(), compatibility: "initial" },
  }), 201, "Publish acceptance model v1");
  cleanup.modelPublished = true;
  if (publishedV1?.key !== modelKey || publishedV1?.version !== 1 || publishedV1?.compatibility !== "initial") {
    throw new Error(`Unexpected v1 publication result: ${JSON.stringify(publishedV1)}`);
  }

  const afterV1Contract = requireStatus(await core("/api/v1/model-admin/contracts/active"), 200, "Read Model Contract after v1");
  if (afterV1Contract?.id === beforeContract?.id) throw new Error("Model Contract revision did not advance after initial publication");

  const publishedV2 = requireStatus(await core("/api/v1/model-admin/models", {
    method: "POST",
    body: { definition: definitionV2(), compatibility: "compatible" },
  }), 201, "Publish acceptance model v2");
  if (publishedV2?.key !== modelKey || publishedV2?.version !== 2 || publishedV2?.compatibility !== "compatible") {
    throw new Error(`Unexpected v2 publication result: ${JSON.stringify(publishedV2)}`);
  }

  const afterV2Contract = requireStatus(await core("/api/v1/model-admin/contracts/active"), 200, "Read Model Contract after v2");
  if (afterV2Contract?.id === afterV1Contract?.id) throw new Error("Model Contract revision did not advance after compatible publication");

  const modelAccessBefore = requireStatus(await core(`/api/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/model-access`), 200, "Read Application × Model Access before acceptance");
  cleanup.originalModelAccess = Array.isArray(modelAccessBefore?.models)
    ? modelAccessBefore.models.map((entry) => ({ modelKey: entry.modelKey, maxAccess: entry.maxAccess }))
    : [];
  const acceptanceAccess = [
    ...cleanup.originalModelAccess.filter((entry) => entry.modelKey !== modelKey),
    { modelKey, maxAccess: "read" },
  ];
  const replaced = requireStatus(await core(`/api/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/model-access`, {
    method: "PUT",
    body: { models: acceptanceAccess },
  }), 200, "Replace Application × Model Access for acceptance");
  cleanup.modelAccessChanged = true;
  if (!replaced?.models?.some((entry) => entry?.modelKey === modelKey && entry?.maxAccess === "read")) {
    throw new Error("Acceptance model access was not applied");
  }

  await restoreModelAccess();
  await retireAcceptanceModel();

  const retiredLookup = await core(`/api/v1/model-admin/models/${encodeURIComponent(modelKey)}`);
  if (retiredLookup.response.status !== 404) {
    throw new Error(`Retired acceptance model remained published: ${retiredLookup.response.status} ${JSON.stringify(retiredLookup.payload)}`);
  }

  const auditData = requireStatus(await core("/api/v1/platform-admin/audit?limit=100"), 200, "Read platform-admin audit after acceptance");
  const auditRows = Array.isArray(auditData) ? auditData : [];
  const relevant = auditRows.filter((entry) => entry?.actorUserId === adminUserId && entry?.actorApplicationId === applicationId);
  const publishRows = relevant.filter((entry) => entry?.operation === "model.publish" && entry?.targetId === modelKey && entry?.result === "success");
  const retireRows = relevant.filter((entry) => entry?.operation === "model.retire" && entry?.targetId === modelKey && entry?.result === "success");
  const accessRows = relevant.filter((entry) => entry?.operation === "application_model_access.replace" && entry?.targetId === applicationId && entry?.result === "success");
  if (publishRows.length < 2 || retireRows.length < 1 || accessRows.length < 2) {
    throw new Error(`Expected audit evidence was not found: ${JSON.stringify({ publish: publishRows.length, retire: retireRows.length, modelAccess: accessRows.length })}`);
  }

  console.log(JSON.stringify({
    ok: true,
    environment: "staging",
    actorUserId: adminUserId,
    actorApplicationId: applicationId,
    acceptanceModel: { key: modelKey, route: modelRoute, publishedVersions: [1, 2], retired: true },
    modelContract: {
      before: beforeContract?.id ?? null,
      afterV1: afterV1Contract?.id ?? null,
      afterV2: afterV2Contract?.id ?? null,
    },
    applicationModelAccess: { targetApplicationId: applicationId, changedAndRestored: true },
    audit: { modelPublish: publishRows.length, modelRetire: retireRows.length, modelAccessReplace: accessRows.length },
    temporaryCredentials: { applicationCredentialRevokedInFinally: true, coreTokenRevokedInFinally: true },
    productionTouched: false,
  }, null, 2));
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  try { await restoreModelAccess(); } catch (error) { cleanupErrors.push(error); }
  try { await retireAcceptanceModel(); } catch (error) { cleanupErrors.push(error); }
  try { await cleanupCredentials(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    const detail = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    if (!primaryError) primaryError = new Error(`Acceptance cleanup failed: ${detail}`);
    else console.error(`Acceptance cleanup also failed: ${detail}`);
  }
}

if (primaryError) throw primaryError;
