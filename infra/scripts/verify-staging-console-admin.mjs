import process from "node:process";
import { STAGING_EXPECTATIONS, assertStagingServiceUrl } from "./staging-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const applicationCredential = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL ?? "").trim();
const coreBearer = (process.env.LIFESPACE_STAGING_CONSOLE_CORE_BEARER ?? "").trim();
const accessAssertion = (process.env.LIFESPACE_STAGING_CONSOLE_ACCESS_ASSERTION ?? "").trim();
const expectedUserId = (process.env.LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID ?? "").trim();
const wrongApplicationCoreBearer = (process.env.LIFESPACE_STAGING_CONSOLE_WRONG_APPLICATION_CORE_BEARER ?? "").trim();

assertStagingServiceUrl(identityBase, "identity");
assertStagingServiceUrl(coreBase, "core");

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL: applicationCredential,
  LIFESPACE_STAGING_CONSOLE_CORE_BEARER: coreBearer,
  LIFESPACE_STAGING_CONSOLE_ACCESS_ASSERTION: accessAssertion,
  LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID: expectedUserId,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (!applicationCredential.startsWith("lsa_")) throw new Error("Console application credential must be lsa_*");
if (!coreBearer.startsWith("lsp_pat_") && coreBearer.split(".").length !== 3) throw new Error("Console Core bearer must be lsp_pat_* or service JWT");
if (!/^usr_[0-9A-Za-z_-]+$/u.test(expectedUserId)) throw new Error("Expected platform administrator must use usr_* identifier");
if (accessAssertion.split(".").length !== 3) throw new Error("LIFESPACE_STAGING_CONSOLE_ACCESS_ASSERTION must be a raw compact JWT");

for (const secret of [applicationCredential, coreBearer, accessAssertion, wrongApplicationCoreBearer]) {
  if (secret) console.log(`::add-mask::${secret}`);
}

async function request(base, path, { method = "GET", bearer = "", actor = "", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
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
  return result.payload;
}

function requireDenied(result, label) {
  if (![401, 403].includes(result.response.status)) {
    throw new Error(`${label} must be denied with 401/403, got ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.error?.code ?? `HTTP_${result.response.status}`;
}

async function requireStagingConvergence() {
  const [identity, core] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  requireStatus(identity, 200, "Identity staging status");
  requireStatus(core, 200, "Core staging status");
  const identityData = identity.payload?.data;
  const coreData = core.payload?.data;
  if (
    identityData?.environment !== "staging"
    || String(identityData?.schemaVersion) !== String(STAGING_EXPECTATIONS.identity.schemaVersion)
    || identityData?.contractVersion !== STAGING_EXPECTATIONS.identity.contractVersion
  ) {
    throw new Error(`Identity staging contract/schema mismatch: ${JSON.stringify(identityData)}`);
  }
  if (
    coreData?.environment !== "staging"
    || String(coreData?.schemaVersion) !== String(STAGING_EXPECTATIONS.core.schemaVersion)
    || coreData?.contractVersion !== STAGING_EXPECTATIONS.core.contractVersion
  ) {
    throw new Error(`Core staging contract/schema mismatch: ${JSON.stringify(coreData)}`);
  }
  return { identity: identityData, core: coreData };
}

const convergence = await requireStagingConvergence();

const exchange = await request(identityBase, "/internal/v1/access/tokens", {
  method: "POST",
  bearer: applicationCredential,
  body: { accessAssertion, requestedScopes: ["profile:read"] },
});
if (exchange.response.status === 409 && exchange.payload?.error?.code === "ACCESS_PRINCIPAL_UNLINKED") {
  throw new Error(
    "The real staging Cloudflare Access principal is valid but not linked to a LifeSpace user. Complete the explicit account-link flow first; this verifier will not auto-create or email-merge an account.",
  );
}
requireStatus(exchange, 200, "Cloudflare Access -> LifeSpace user exchange");
const userToken = exchange.payload?.data?.accessToken;
if (typeof userToken !== "string" || userToken.split(".").length !== 3) throw new Error("Identity did not return a valid LifeSpace user JWT");
console.log(`::add-mask::${userToken}`);
if (exchange.payload?.data?.scope !== "profile:read") throw new Error(`Unexpected Console user scope: ${String(exchange.payload?.data?.scope)}`);

const profile = await request(identityBase, "/api/v1/me", { bearer: userToken });
requireStatus(profile, 200, "Console LifeSpace user profile");
if (profile.payload?.data?.id !== expectedUserId) {
  throw new Error(`Access principal resolved to ${String(profile.payload?.data?.id)}, expected assigned platform administrator ${expectedUserId}`);
}

const actorIssue = await request(identityBase, "/api/v1/me/platform-admin-actor-token", { method: "POST", bearer: userToken });
requireStatus(actorIssue, 200, "Platform-admin actor proof issuance");
const actorToken = actorIssue.payload?.data?.actorToken;
if (typeof actorToken !== "string" || actorToken.split(".").length !== 3) throw new Error("Identity did not return a valid platform-admin actor JWT");
console.log(`::add-mask::${actorToken}`);
if (
  actorIssue.payload?.data?.expiresIn !== 300
  || actorIssue.payload?.data?.scope !== "platform:admin"
  || actorIssue.payload?.data?.purpose !== "platform_admin_actor"
) {
  throw new Error(`Actor proof contract mismatch: ${JSON.stringify({
    expiresIn: actorIssue.payload?.data?.expiresIn,
    scope: actorIssue.payload?.data?.scope,
    purpose: actorIssue.payload?.data?.purpose,
  })}`);
}

const identityApplications = await request(identityBase, "/internal/v1/platform-admin/applications", {
  bearer: applicationCredential,
  actor: actorToken,
});
requireStatus(identityApplications, 200, "Identity platform application inspector");
if (!Array.isArray(identityApplications.payload?.data)) throw new Error("Identity platform application response is not an array");

const identityUsers = await request(identityBase, "/internal/v1/platform-admin/users?limit=1", {
  bearer: applicationCredential,
  actor: actorToken,
});
requireStatus(identityUsers, 200, "Identity user inspector");
if (!Array.isArray(identityUsers.payload?.data)) throw new Error("Identity user inspector response is not an array");

const identityAudit = await request(identityBase, "/internal/v1/platform-admin/audit?limit=5", {
  bearer: applicationCredential,
  actor: actorToken,
});
requireStatus(identityAudit, 200, "Identity platform audit read");
if (!Array.isArray(identityAudit.payload?.data)) throw new Error("Identity audit response is not an array");

const identityMissingActor = await request(identityBase, "/internal/v1/platform-admin/applications", { bearer: applicationCredential });
const identityMissingActorCode = requireDenied(identityMissingActor, "Identity platform admin without actor proof");

const identityWrongPurpose = await request(identityBase, "/internal/v1/platform-admin/applications", {
  bearer: applicationCredential,
  actor: userToken,
});
const identityWrongPurposeCode = requireDenied(identityWrongPurpose, "Identity platform admin with ordinary user JWT as actor proof");

const corePrincipal = await request(coreBase, "/api/v1/me", { bearer: coreBearer });
requireStatus(corePrincipal, 200, "Console Core executor authentication");
if (corePrincipal.payload?.data?.principal?.type !== "service") throw new Error("Console Core executor is not a service principal");

const coreSpaces = await request(coreBase, "/api/v1/platform-admin/spaces?limit=1", {
  bearer: coreBearer,
  actor: actorToken,
});
requireStatus(coreSpaces, 200, "Core Space inspector");
if (!Array.isArray(coreSpaces.payload?.data)) throw new Error("Core Space inspector response is not an array");

const coreAudit = await request(coreBase, "/api/v1/platform-admin/audit?limit=5", {
  bearer: coreBearer,
  actor: actorToken,
});
requireStatus(coreAudit, 200, "Core platform audit read");
if (!Array.isArray(coreAudit.payload?.data)) throw new Error("Core audit response is not an array");

const coreMissingActor = await request(coreBase, "/api/v1/platform-admin/spaces?limit=1", { bearer: coreBearer });
const coreMissingActorCode = requireDenied(coreMissingActor, "Core platform admin without actor proof");

const coreWrongPurpose = await request(coreBase, "/api/v1/platform-admin/spaces?limit=1", {
  bearer: coreBearer,
  actor: userToken,
});
const coreWrongPurposeCode = requireDenied(coreWrongPurpose, "Core platform admin with ordinary user JWT as actor proof");

const modelAdminAutomation = await request(coreBase, "/api/v1/model-admin/models", { bearer: coreBearer });
requireStatus(modelAdminAutomation, 200, "Service-only Model Admin automation compatibility");
if (!Array.isArray(modelAdminAutomation.payload?.data)) throw new Error("Model Admin list response is not an array");

let crossApplication = { tested: false, result: "not-configured" };
if (wrongApplicationCoreBearer) {
  console.log(`::add-mask::${wrongApplicationCoreBearer}`);
  const wrongPrincipal = await request(coreBase, "/api/v1/me", { bearer: wrongApplicationCoreBearer });
  requireStatus(wrongPrincipal, 200, "Wrong-application Core bearer authentication");
  if (wrongPrincipal.payload?.data?.principal?.type !== "service") throw new Error("Wrong-application bearer is not a service principal");
  if (wrongPrincipal.payload?.data?.principal?.clientId === corePrincipal.payload?.data?.principal?.clientId) {
    throw new Error("LIFESPACE_STAGING_CONSOLE_WRONG_APPLICATION_CORE_BEARER belongs to the same application and cannot prove cross-application denial");
  }
  const mismatch = await request(coreBase, "/api/v1/platform-admin/spaces?limit=1", {
    bearer: wrongApplicationCoreBearer,
    actor: actorToken,
  });
  if (mismatch.response.status !== 403 || mismatch.payload?.error?.code !== "PLATFORM_ADMIN_ACTOR_MISMATCH") {
    throw new Error(`Cross-application actor/executor pairing must fail with PLATFORM_ADMIN_ACTOR_MISMATCH: ${mismatch.response.status} ${JSON.stringify(mismatch.payload)}`);
  }
  crossApplication = { tested: true, result: mismatch.payload.error.code };
}

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  contracts: {
    identity: convergence.identity.contractVersion,
    coreKernel: convergence.core.contractVersion,
    identityPlatformAdmin: "0.1.0",
    corePlatformAdmin: "0.1.0",
  },
  actor: {
    userId: expectedUserId,
    expiresIn: actorIssue.payload.data.expiresIn,
    scope: actorIssue.payload.data.scope,
    purpose: actorIssue.payload.data.purpose,
  },
  positive: {
    accessExchange: true,
    identityApplications: true,
    identityUsers: true,
    identityAudit: true,
    coreSpaces: true,
    coreAudit: true,
    serviceOnlyModelAdminCompatibility: true,
  },
  deny: {
    identityMissingActor: identityMissingActorCode,
    identityOrdinaryUserTokenAsActor: identityWrongPurposeCode,
    coreMissingActor: coreMissingActorCode,
    coreOrdinaryUserTokenAsActor: coreWrongPurposeCode,
    crossApplication,
  },
  mutationsPerformed: false,
  productionTouched: false,
}, null, 2));
