import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = (process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "").trim();
const consoleApplicationId = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging").trim();
const explicitAdminUserId = (process.env.LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID ?? "").trim();
const runSuffix = String(process.env.GITHUB_RUN_ID ?? Date.now()).replace(/\D/gu, "").slice(-18) || String(Date.now());

function assertStagingUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.includes("staging") || url.hostname === "core.aisr.online" || url.hostname === "auth.aisr.online") {
    throw new Error(`${label} must be an explicit staging HTTPS URL, got ${value}`);
  }
}

assertStagingUrl(identityBase, "Identity URL");
assertStagingUrl(coreBase, "Core URL");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^app_[0-9A-Za-z_-]+$/u.test(consoleApplicationId)) throw new Error("Console application id is invalid");
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

const cleanup = {
  consoleCredentialId: "",
  consoleCredential: "",
  actorToken: "",
  targetApplicationId: "",
  targetInitialCredentialId: "",
  targetInitialSecret: "",
  targetReplacementCredentialId: "",
  targetReplacementSecret: "",
  audienceId: "",
  principalId: "",
  tokenId: "",
  tokenSecret: "",
  tokenRevoked: false,
  agentId: "",
  agentCredentialId: "",
  agentCredentialSecret: "",
  agentCredentialRevoked: false,
  agentDisabled: false,
  principalDisabled: false,
  audienceRevoked: false,
  initialCredentialRevoked: false,
  replacementCredentialRevoked: false,
  targetApplicationDisabled: false,
};

let adminUserId = "";

function admin(path, options = {}) {
  return request(identityBase, path, {
    ...options,
    bearer: cleanup.consoleCredential,
    actor: cleanup.actorToken,
  });
}

async function bestEffort(label, fn) {
  try { await fn(); }
  catch (error) { console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function revokeToken() {
  if (!cleanup.targetApplicationId || !cleanup.principalId || !cleanup.tokenId || cleanup.tokenRevoked) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens/${encodeURIComponent(cleanup.tokenId)}`, { method: "DELETE" });
  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Token cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.tokenRevoked = true;
}

async function revokeAgentCredential() {
  if (!cleanup.targetApplicationId || !cleanup.agentId || !cleanup.agentCredentialId || cleanup.agentCredentialRevoked) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, { method: "DELETE" });
  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Agent credential cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.agentCredentialRevoked = true;
}

async function disableAgent() {
  if (!cleanup.targetApplicationId || !cleanup.agentId || cleanup.agentDisabled) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}`, {
    method: "PATCH",
    body: { displayName: `Disabled staging acceptance Agent ${runSuffix}`, status: "disabled" },
  });
  if (result.response.status !== 200 && result.response.status !== 404) throw new Error(`Agent cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.agentDisabled = true;
}

async function disablePrincipal() {
  if (!cleanup.targetApplicationId || !cleanup.principalId || cleanup.principalDisabled) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}`, {
    method: "PATCH",
    body: { status: "disabled" },
  });
  if (result.response.status !== 200 && result.response.status !== 404) throw new Error(`Principal cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.principalDisabled = true;
}

async function revokeAudience() {
  if (!cleanup.targetApplicationId || !cleanup.audienceId || cleanup.audienceRevoked) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/access-audiences/${encodeURIComponent(cleanup.audienceId)}`, { method: "DELETE" });
  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Audience cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.audienceRevoked = true;
}

async function revokeTargetCredential(id, flag) {
  if (!cleanup.targetApplicationId || !id || cleanup[flag]) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Target credential cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup[flag] = true;
}

async function disableTargetApplication() {
  if (!cleanup.targetApplicationId || cleanup.targetApplicationDisabled) return;
  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}`, {
    method: "PATCH",
    body: { status: "disabled" },
  });
  if (result.response.status !== 200 && result.response.status !== 404) throw new Error(`Target application cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.targetApplicationDisabled = true;
}

async function revokeConsoleCredential() {
  if (!cleanup.consoleCredentialId) return;
  const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(consoleApplicationId)}/credentials/${encodeURIComponent(cleanup.consoleCredentialId)}`, {
    method: "DELETE",
    bootstrap: true,
  });
  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Console credential cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  cleanup.consoleCredentialId = "";
  cleanup.consoleCredential = "";
}

let primaryError = null;
try {
  const [identityStatus, coreStatus] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  const identityData = requireStatus(identityStatus, 200, "Identity staging status");
  const coreData = requireStatus(coreStatus, 200, "Core staging status");
  if (identityData?.environment !== "staging" || coreData?.environment !== "staging") throw new Error("Refusing to run configuration-center acceptance outside staging");

  adminUserId = await resolveAdminUserId();

  const consoleApp = requireStatus(await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(consoleApplicationId)}`, { bootstrap: true }), 200, "Load Console application");
  const requiredScopes = ["profile:read", "platform:admin", "applications:manage", "services:manage", "audit:read"];
  const missingScopes = requiredScopes.filter((scope) => !consoleApp?.allowedScopes?.includes(scope));
  if (consoleApp?.trustedBackend !== true || consoleApp?.status !== "active" || missingScopes.length) {
    throw new Error(`Console application is not ready for Slice B/C acceptance: missing scopes ${missingScopes.join(",") || "none"}`);
  }

  const consoleCredential = requireStatus(await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(consoleApplicationId)}/credentials`, {
    method: "POST",
    bootstrap: true,
  }), 201, "Create temporary Console Identity executor");
  cleanup.consoleCredentialId = consoleCredential?.id ?? "";
  cleanup.consoleCredential = consoleCredential?.clientSecret ?? "";
  if (!cleanup.consoleCredentialId || !cleanup.consoleCredential.startsWith("lsa_")) throw new Error("Temporary Console executor credential is invalid");
  mask(cleanup.consoleCredential);

  const userTokenData = requireStatus(await request(identityBase, "/internal/v1/tokens", {
    method: "POST",
    bearer: cleanup.consoleCredential,
    body: { subjectId: adminUserId, scopes: ["profile:read"] },
  }), 200, "Issue temporary Console user token");
  const userToken = userTokenData?.accessToken ?? "";
  if (!userToken || userToken.split(".").length !== 3) throw new Error("Temporary Console user token is invalid");
  mask(userToken);

  const actorData = requireStatus(await request(identityBase, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    bearer: userToken,
  }), 200, "Issue platform-admin actor proof");
  cleanup.actorToken = actorData?.actorToken ?? "";
  if (!cleanup.actorToken || cleanup.actorToken.split(".").length !== 3) throw new Error("Platform-admin actor proof is invalid");
  mask(cleanup.actorToken);

  const beforeAudit = requireStatus(await admin("/internal/v1/platform-admin/audit?limit=200"), 200, "Read Identity audit before acceptance");
  const beforeAuditIds = new Set(Array.isArray(beforeAudit) ? beforeAudit.map((entry) => entry?.id).filter(Boolean) : []);

  const targetName = `Console MVP Acceptance ${runSuffix}`;
  const created = requireStatus(await admin("/internal/v1/platform-admin/applications", {
    method: "POST",
    body: {
      name: targetName,
      allowedScopes: ["resources:read", "resources:write"],
      trustedBackend: true,
      accessTokenTtlSeconds: 900,
    },
  }), 201, "Create target staging Application");
  cleanup.targetApplicationId = created?.id ?? "";
  cleanup.targetInitialCredentialId = created?.credential?.id ?? "";
  cleanup.targetInitialSecret = created?.clientSecret ?? "";
  if (!/^app_[0-9A-Za-z_-]+$/u.test(cleanup.targetApplicationId)) throw new Error(`Generated target Application id is invalid: ${cleanup.targetApplicationId}`);
  if (!cleanup.targetInitialCredentialId || !cleanup.targetInitialSecret.startsWith("lsa_")) throw new Error("Trusted target Application did not return its one-time initial credential");
  mask(cleanup.targetInitialSecret);

  const updated = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}`, {
    method: "PATCH",
    body: {
      name: `${targetName} Updated`,
      allowedScopes: ["resources:read", "resources:write", "resources:manage"],
      accessTokenTtlSeconds: 1200,
    },
  }), 200, "Update target Application policy");
  if (updated?.name !== `${targetName} Updated` || updated?.accessTokenTtlSeconds !== 1200 || !updated?.allowedScopes?.includes("resources:manage")) {
    throw new Error(`Target Application update did not persist expected policy: ${JSON.stringify(updated)}`);
  }

  const audienceValue = `console-mvp-acceptance-${runSuffix}`;
  const audience = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/access-audiences`, {
    method: "POST",
    body: { audience: audienceValue },
  }), [200, 201], "Register target Access audience");
  cleanup.audienceId = audience?.id ?? "";
  if (!cleanup.audienceId || audience?.audience !== audienceValue || audience?.status !== "active") throw new Error(`Unexpected Access audience result: ${JSON.stringify(audience)}`);

  const audiences = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/access-audiences`), 200, "List target Access audiences");
  if (!Array.isArray(audiences) || !audiences.some((entry) => entry?.id === cleanup.audienceId && entry?.status === "active")) throw new Error("Registered Access audience did not appear in metadata list");

  const replacement = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/credentials`, {
    method: "POST",
  }), 201, "Create replacement target Application credential");
  cleanup.targetReplacementCredentialId = replacement?.id ?? "";
  cleanup.targetReplacementSecret = replacement?.clientSecret ?? "";
  if (!cleanup.targetReplacementCredentialId || !cleanup.targetReplacementSecret.startsWith("lsa_")) throw new Error("Replacement target Application credential is invalid");
  mask(cleanup.targetReplacementSecret);

  const credentialRows = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/credentials`), 200, "List target credential metadata");
  const serializedCredentials = JSON.stringify(credentialRows);
  if (!Array.isArray(credentialRows) || !credentialRows.some((entry) => entry?.id === cleanup.targetReplacementCredentialId)) throw new Error("Replacement credential did not appear in metadata list");
  if (serializedCredentials.includes(cleanup.targetInitialSecret) || serializedCredentials.includes(cleanup.targetReplacementSecret)) throw new Error("Credential metadata list leaked plaintext");

  const agent = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents`, {
    method: "POST",
    body: { displayName: `MVP acceptance Agent ${runSuffix}` },
  }), 201, "Create target Agent identity");
  cleanup.agentId = agent?.id ?? "";
  if (!/^agt_[0-9A-Za-z_-]+$/u.test(cleanup.agentId)) throw new Error(`Agent id is invalid: ${cleanup.agentId}`);

  const agentCredential = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials`, {
    method: "POST",
    body: {
      label: `MVP acceptance Agent credential ${runSuffix}`,
      scopes: ["resources:read", "resources:write"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  }), 201, "Create target Agent API credential");
  cleanup.agentCredentialId = agentCredential?.id ?? "";
  cleanup.agentCredentialSecret = agentCredential?.token ?? "";
  if (!/^agc_[0-9A-Za-z_-]+$/u.test(cleanup.agentCredentialId) || !cleanup.agentCredentialSecret.startsWith("lsp_agt_")) throw new Error("Agent API credential result is invalid");
  mask(cleanup.agentCredentialSecret);

  const reducedAgentCredential = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, {
    method: "PATCH",
    body: { scopes: ["resources:read"], expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
  }), 200, "Reduce target Agent API credential scope");
  if (!Array.isArray(reducedAgentCredential?.scopes) || reducedAgentCredential.scopes.length !== 1 || reducedAgentCredential.scopes[0] !== "resources:read") {
    throw new Error(`Agent credential scope reduction did not persist: ${JSON.stringify(reducedAgentCredential)}`);
  }

  const agentExpansion = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, {
    method: "PATCH",
    body: { scopes: ["resources:read", "resources:write"] },
  });
  if (agentExpansion.response.status !== 422 && agentExpansion.response.status !== 403) {
    throw new Error(`Agent credential scope expansion should be denied, got ${agentExpansion.response.status}: ${JSON.stringify(agentExpansion.payload)}`);
  }

  const agentCredentialRows = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials`), 200, "List Agent API credential metadata");
  if (!Array.isArray(agentCredentialRows) || !agentCredentialRows.some((entry) => entry?.id === cleanup.agentCredentialId && entry?.scopes?.length === 1 && entry?.scopes?.[0] === "resources:read")) {
    throw new Error("Reduced Agent API credential did not appear in metadata list");
  }
  if (JSON.stringify(agentCredentialRows).includes(cleanup.agentCredentialSecret)) throw new Error("Agent credential metadata list leaked plaintext");

  await revokeAgentCredential();
  await disableAgent();

  const principal = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals`, {
    method: "POST",
    body: {
      displayName: `MVP acceptance service ${runSuffix}`,
      description: "Disposable staging-only service principal used to verify LifeSpace Console Slice C.",
      maxScopes: ["resources:read", "resources:write"],
    },
  }), 201, "Create target Service Principal");
  cleanup.principalId = principal?.id ?? "";
  if (!/^svc_[0-9A-Za-z_-]+$/u.test(cleanup.principalId)) throw new Error(`Service Principal id is invalid: ${cleanup.principalId}`);

  const token = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens`, {
    method: "POST",
    body: {
      label: `MVP acceptance token ${runSuffix}`,
      scopes: ["resources:read", "resources:write"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  }), 201, "Create target Service API Token");
  cleanup.tokenId = token?.id ?? "";
  cleanup.tokenSecret = token?.token ?? "";
  if (!/^sat_[0-9A-Za-z_-]+$/u.test(cleanup.tokenId) || !cleanup.tokenSecret.startsWith("lsp_svc_")) throw new Error("Service API Token result is invalid");
  mask(cleanup.tokenSecret);

  const reduced = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens/${encodeURIComponent(cleanup.tokenId)}`, {
    method: "PATCH",
    body: {
      label: `MVP acceptance token reduced ${runSuffix}`,
      scopes: ["resources:read"],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  }), 200, "Reduce target Service API Token scope");
  if (!Array.isArray(reduced?.scopes) || reduced.scopes.length !== 1 || reduced.scopes[0] !== "resources:read") throw new Error(`Service token scope reduction did not persist: ${JSON.stringify(reduced)}`);

  const expansion = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens/${encodeURIComponent(cleanup.tokenId)}`, {
    method: "PATCH",
    body: { scopes: ["resources:read", "resources:write"] },
  });
  if (expansion.response.status !== 422 && expansion.response.status !== 403) {
    throw new Error(`Service token scope expansion should be denied, got ${expansion.response.status}: ${JSON.stringify(expansion.payload)}`);
  }

  const tokenRows = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals/${encodeURIComponent(cleanup.principalId)}/tokens`), 200, "List Service API Token metadata");
  if (!Array.isArray(tokenRows) || !tokenRows.some((entry) => entry?.id === cleanup.tokenId && entry?.scopes?.length === 1 && entry?.scopes?.[0] === "resources:read")) throw new Error("Reduced Service API Token did not appear in metadata list");
  if (JSON.stringify(tokenRows).includes(cleanup.tokenSecret)) throw new Error("Service token metadata list leaked plaintext");

  await revokeToken();
  await revokeAgentCredential();
  await disableAgent();
  await disablePrincipal();
  await revokeAudience();
  await revokeTargetCredential(cleanup.targetReplacementCredentialId, "replacementCredentialRevoked");
  await revokeTargetCredential(cleanup.targetInitialCredentialId, "initialCredentialRevoked");
  await disableTargetApplication();

  const finalApp = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}`), 200, "Read final target Application state");
  if (finalApp?.status !== "disabled") throw new Error(`Acceptance Application was not disabled after cleanup: ${JSON.stringify(finalApp)}`);

  const afterAudit = requireStatus(await admin("/internal/v1/platform-admin/audit?limit=200"), 200, "Read Identity audit after acceptance");
  const newAuditRows = Array.isArray(afterAudit) ? afterAudit.filter((entry) => entry?.id && !beforeAuditIds.has(entry.id)) : [];
  const targetIds = new Set([
    cleanup.targetApplicationId,
    cleanup.targetInitialCredentialId,
    cleanup.targetReplacementCredentialId,
    cleanup.audienceId,
    cleanup.principalId,
    cleanup.tokenId,
    cleanup.agentId,
    cleanup.agentCredentialId,
  ].filter(Boolean));
  const relevantAudit = newAuditRows.filter((entry) => entry?.actorUserId === adminUserId && targetIds.has(entry?.targetId));
  if (relevantAudit.length < 13) throw new Error(`Expected at least 13 human-attributed target audit entries, found ${relevantAudit.length}: ${JSON.stringify(relevantAudit)}`);
  for (const operation of ["agent.create", "agent.update", "agent.api_credential.create", "agent.api_credential.update", "agent.api_credential.revoke"]) {
    if (!relevantAudit.some((entry) => entry?.operation === operation)) throw new Error(`Missing human-attributed ${operation} audit entry: ${JSON.stringify(relevantAudit)}`);
  }
  const auditSerialized = JSON.stringify(relevantAudit);
  for (const secret of [cleanup.targetInitialSecret, cleanup.targetReplacementSecret, cleanup.tokenSecret, cleanup.agentCredentialSecret]) {
    if (secret && auditSerialized.includes(secret)) throw new Error("Platform-admin audit leaked credential plaintext");
  }

  console.log(JSON.stringify({
    ok: true,
    environment: "staging",
    identityContractVersion: identityData?.contractVersion ?? null,
    coreContractVersion: coreData?.contractVersion ?? null,
    actorUserId: adminUserId,
    targetApplicationId: cleanup.targetApplicationId,
    targetApplicationFinalStatus: finalApp?.status,
    accessAudienceRegisteredAndRevoked: true,
    applicationCredentialRotationProven: true,
    servicePrincipalLifecycleProven: true,
    serviceTokenCreateReduceExpansionDenyRevokeProven: true,
    agentIdentityLifecycleProven: true,
    agentCredentialCreateReduceExpansionDenyRevokeProven: true,
    auditEntriesObserved: relevantAudit.length,
    plaintextMetadataLeak: false,
    productionTouched: false,
  }));
} catch (error) {
  primaryError = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await bestEffort("Cleanup token", revokeToken);
  await bestEffort("Cleanup Agent credential", revokeAgentCredential);
  await bestEffort("Cleanup Agent", disableAgent);
  await bestEffort("Cleanup principal", disablePrincipal);
  await bestEffort("Cleanup audience", revokeAudience);
  await bestEffort("Cleanup replacement credential", () => revokeTargetCredential(cleanup.targetReplacementCredentialId, "replacementCredentialRevoked"));
  await bestEffort("Cleanup initial credential", () => revokeTargetCredential(cleanup.targetInitialCredentialId, "initialCredentialRevoked"));
  await bestEffort("Disable acceptance Application", disableTargetApplication);
  await bestEffort("Revoke temporary Console executor", revokeConsoleCredential);
}

if (primaryError) process.exitCode = 1;
