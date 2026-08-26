import { appendFileSync } from "node:fs";
import process from "node:process";
import { PRODUCTION_EXPECTATIONS, assertProductionServiceUrl } from "./production-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const cloudflareAccountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
const cloudflareApiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
const suppliedAudience = (process.env.LIFESPACE_PRODUCTION_CONSOLE_ACCESS_AUD ?? "").trim();
const suppliedAdminUserId = (process.env.LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID ?? "").trim();
const applicationId = (process.env.LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_ID ?? "app_lifespace_console").trim();
const applicationName = (process.env.LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_NAME ?? "LifeSpace Console").trim();
const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

const TOKEN_TTL_SECONDS = 900;
const APPLICATION_SCOPES = [
  "profile:read",
  "platform:admin",
  "applications:manage",
  "services:manage",
  "identities:read",
  "models:manage",
  "spaces:inspect",
  "audit:read",
];
const CORE_EXECUTOR_SCOPES = [
  "applications:manage",
  "models:manage",
  "spaces:inspect",
  "audit:read",
];
const CORE_EXECUTOR_NAME = "LifeSpace Console Core executor (production)";
const CORE_EXECUTOR_DESCRIPTION = "Dedicated production Core control-plane executor for LifeSpace Console";
const CORE_TOKEN_LABEL = "LifeSpace Console production Core executor";
const ACCESS_DOMAIN = "lifespace.aisr.online";

assertProductionServiceUrl(identityBase, "identity");
assertProductionServiceUrl(coreBase, "core");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!cloudflareAccountId || !cloudflareApiToken) throw new Error("Cloudflare account/token are required for production Access preflight");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_ID must use an app_* identifier");
if (suppliedAdminUserId && !/^usr_[0-9A-Za-z_-]+$/u.test(suppliedAdminUserId)) throw new Error("LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID must use a usr_* identifier");
if (!githubEnv) throw new Error("GITHUB_ENV is required as the ephemeral secret sink");

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}
mask(bootstrapSecret);
mask(cloudflareApiToken);

function persist(name, value, { secret = false } = {}) {
  if (typeof value !== "string" || !value || /[\r\n]/u.test(value)) throw new Error(`${name} is invalid`);
  if (secret) mask(value);
  appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

async function request(base, path, { method = "GET", bootstrap = false, bearer = "", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
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

async function requireProductionConvergence() {
  const [identity, core] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  const identityData = identity.payload?.data;
  const coreData = core.payload?.data;
  if (
    identity.response.status !== 200
    || identityData?.environment !== "production"
    || String(identityData?.schemaVersion) !== String(PRODUCTION_EXPECTATIONS.identity.schemaVersion)
    || identityData?.contractVersion !== PRODUCTION_EXPECTATIONS.identity.contractVersion
  ) {
    throw new Error(`Identity production must already be schema v${PRODUCTION_EXPECTATIONS.identity.schemaVersion} / contract ${PRODUCTION_EXPECTATIONS.identity.contractVersion}; got ${identity.response.status} ${JSON.stringify(identity.payload)}`);
  }
  if (
    core.response.status !== 200
    || coreData?.environment !== "production"
    || String(coreData?.schemaVersion) !== String(PRODUCTION_EXPECTATIONS.core.schemaVersion)
    || coreData?.contractVersion !== PRODUCTION_EXPECTATIONS.core.contractVersion
  ) {
    throw new Error(`Core production must already be schema v${PRODUCTION_EXPECTATIONS.core.schemaVersion} / contract ${PRODUCTION_EXPECTATIONS.core.contractVersion}; got ${core.response.status} ${JSON.stringify(core.payload)}`);
  }
  return { identity: identityData, core: coreData };
}

async function resolveAccessAudience() {
  if (suppliedAudience) {
    if (/\s/u.test(suppliedAudience)) throw new Error("LIFESPACE_PRODUCTION_CONSOLE_ACCESS_AUD must not contain whitespace");
    return { audience: suppliedAudience, source: "environment" };
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccountId)}/access/apps?per_page=100`, {
    headers: { authorization: `Bearer ${cloudflareApiToken}`, accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !Array.isArray(payload?.result)) {
    throw new Error(`Could not inspect Cloudflare Access applications: ${response.status} ${JSON.stringify(payload)}`);
  }
  const matches = payload.result.filter((entry) => {
    const domains = [entry?.domain, ...(Array.isArray(entry?.self_hosted_domains) ? entry.self_hosted_domains : [])].filter(Boolean);
    return domains.includes(ACCESS_DOMAIN);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Cloudflare Access application for ${ACCESS_DOMAIN}, found ${matches.length}. Create/protect the production Access application before deploying Console.`);
  }
  const audience = typeof matches[0]?.aud === "string" ? matches[0].aud.trim() : "";
  if (!audience || /\s/u.test(audience)) throw new Error(`Cloudflare Access application for ${ACCESS_DOMAIN} did not expose a valid aud`);
  return { audience, source: "cloudflare-access" };
}

async function resolvePlatformAdminUserId() {
  if (suppliedAdminUserId) return suppliedAdminUserId;
  const result = await request(identityBase, "/bootstrap/v1/platform-administrators", { bootstrap: true });
  if (result.response.status !== 200 || !Array.isArray(result.payload?.data)) {
    throw new Error(`Could not list production platform administrators: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  const active = result.payload.data.filter((entry) => entry?.status === "active" && entry?.userStatus === "active" && typeof entry?.userId === "string");
  if (active.length !== 1) {
    throw new Error(`Expected exactly one active production platform administrator or LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID, found ${active.length}`);
  }
  return active[0].userId;
}

async function loadApplication() {
  return request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
}

async function createOrReconcileApplication() {
  let lookup = await loadApplication();
  let created = false;
  let initialSecret = "";
  if (lookup.response.status === 404) {
    const result = await request(identityBase, "/bootstrap/v1/applications", {
      method: "POST",
      bootstrap: true,
      body: {
        id: applicationId,
        name: applicationName,
        clientType: "web",
        allowedScopes: APPLICATION_SCOPES,
        trustedBackend: true,
        accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
      },
    });
    initialSecret = result.payload?.data?.clientSecret ?? "";
    if (result.response.status !== 201 || result.payload?.data?.id !== applicationId || !initialSecret.startsWith("lsa_")) {
      throw new Error(`Production Console application creation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    mask(initialSecret);
    created = true;
    lookup = await loadApplication();
  }
  if (lookup.response.status !== 200 || lookup.payload?.data?.id !== applicationId) {
    throw new Error(`Production Console application lookup failed: ${lookup.response.status} ${JSON.stringify(lookup.payload)}`);
  }

  const existing = lookup.payload.data;
  if (existing.clientType !== "web" || existing.trustedBackend !== true) {
    throw new Error(`Existing production Console application has incompatible immutable classification: ${JSON.stringify({ clientType: existing.clientType, trustedBackend: existing.trustedBackend })}`);
  }
  const patch = {};
  if (existing.name !== applicationName) patch.name = applicationName;
  if (!sameStringSet(existing.allowedScopes, APPLICATION_SCOPES)) patch.allowedScopes = APPLICATION_SCOPES;
  if (existing.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
  if (existing.status !== "active") patch.status = "active";
  if (Object.keys(patch).length) {
    const updated = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
      method: "PATCH",
      bootstrap: true,
      body: patch,
    });
    if (updated.response.status !== 200) throw new Error(`Production Console application reconciliation failed: ${updated.response.status} ${JSON.stringify(updated.payload)}`);
  }
  return { created, initialSecret };
}

async function ensureAudience(audience) {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/access-audiences`;
  const list = await request(identityBase, path, { bootstrap: true });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) {
    throw new Error(`Production Console Access audience listing failed: ${list.response.status} ${JSON.stringify(list.payload)}`);
  }
  const current = list.payload.data.find((entry) => entry?.audience === audience && entry?.status === "active");
  if (current) return { created: false, entry: current };
  const created = await request(identityBase, path, { method: "POST", bootstrap: true, body: { audience } });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== audience) {
    throw new Error(`Production Console Access audience registration failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  return { created: created.response.status === 201, entry: created.payload.data };
}

async function ensurePlatformAdministrator(userId) {
  const result = await request(identityBase, `/bootstrap/v1/platform-administrators/${encodeURIComponent(userId)}`, {
    method: "PUT",
    bootstrap: true,
  });
  if (result.response.status !== 200 || result.payload?.data?.userId !== userId) {
    throw new Error(`Production platform administrator assignment failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload.data;
}

async function rotateApplicationCredential(applicationCreated, initialSecret) {
  let secret = initialSecret;
  if (!applicationCreated) {
    const created = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, {
      method: "POST",
      bootstrap: true,
    });
    secret = created.payload?.data?.clientSecret ?? "";
    if (created.response.status !== 201 || !secret.startsWith("lsa_")) {
      throw new Error(`Production Console application credential rotation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
    }
  }
  if (!secret.startsWith("lsa_")) throw new Error("Production Console application credential was not produced");
  mask(secret);

  const list = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { bootstrap: true });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) throw new Error(`Could not list production Console credentials: ${list.response.status}`);
  const active = list.payload.data.filter((entry) => entry?.status === "active" && entry?.revokedAt == null);
  const current = active.filter((entry) => entry?.secretSuffix === secret.slice(-8));
  if (current.length !== 1) throw new Error("Could not uniquely identify the new production Console application credential");
  const oldIds = active.filter((entry) => entry.id !== current[0].id).map((entry) => entry.id);
  return { secret, id: current[0].id, oldIds };
}

async function ensureCoreExecutor(applicationCredential, adminUserId) {
  const list = await request(identityBase, "/api/v1/service-principals", { bearer: applicationCredential });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) {
    throw new Error(`Could not list production Console service principals: ${list.response.status} ${JSON.stringify(list.payload)}`);
  }
  const matches = list.payload.data.filter((entry) => entry?.displayName === CORE_EXECUTOR_NAME);
  if (matches.length > 1) throw new Error(`Multiple production service principals use reserved name ${CORE_EXECUTOR_NAME}`);
  let principal = matches[0];
  if (!principal) {
    const created = await request(identityBase, "/api/v1/service-principals", {
      method: "POST",
      bearer: applicationCredential,
      body: {
        displayName: CORE_EXECUTOR_NAME,
        description: CORE_EXECUTOR_DESCRIPTION,
        maxScopes: CORE_EXECUTOR_SCOPES,
        createdByUserId: adminUserId,
      },
    });
    principal = created.payload?.data;
    if (created.response.status !== 201 || !principal?.id?.startsWith("svc_")) throw new Error(`Production Console Core executor creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  } else {
    if (principal.clientId !== applicationId) throw new Error(`Production Console Core executor belongs to ${String(principal.clientId)}, expected ${applicationId}`);
    const patch = {};
    if (principal.description !== CORE_EXECUTOR_DESCRIPTION) patch.description = CORE_EXECUTOR_DESCRIPTION;
    if (!sameStringSet(principal.maxScopes, CORE_EXECUTOR_SCOPES)) patch.maxScopes = CORE_EXECUTOR_SCOPES;
    if (principal.status !== "active") patch.status = "active";
    if (Object.keys(patch).length) {
      const updated = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principal.id)}`, {
        method: "PATCH",
        bearer: applicationCredential,
        body: patch,
      });
      if (updated.response.status !== 200) throw new Error(`Production Console Core executor reconciliation failed: ${updated.response.status} ${JSON.stringify(updated.payload)}`);
      principal = updated.payload?.data;
    }
  }
  if (!sameStringSet(principal?.maxScopes, CORE_EXECUTOR_SCOPES)) throw new Error("Production Console Core executor scope ceiling is not least-privilege exact");
  return principal;
}

async function rotateCoreToken(applicationCredential, principalId, adminUserId) {
  const list = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, { bearer: applicationCredential });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) throw new Error(`Could not list production Console Core tokens: ${list.response.status}`);
  const before = list.payload.data.filter((entry) => entry?.revokedAt == null && (!entry?.expiresAt || Date.parse(entry.expiresAt) > Date.now()));

  const created = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, {
    method: "POST",
    bearer: applicationCredential,
    body: {
      label: CORE_TOKEN_LABEL,
      scopes: CORE_EXECUTOR_SCOPES,
      expiresAt: null,
      createdByUserId: adminUserId,
    },
  });
  const tokenId = created.payload?.data?.id ?? "";
  const token = created.payload?.data?.token ?? "";
  if (created.response.status !== 201 || !tokenId.startsWith("sat_") || !token.startsWith("lsp_pat_")) {
    throw new Error(`Production Console Core token rotation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  mask(token);

  const verified = await request(coreBase, "/api/v1/model-admin/models", { bearer: token });
  if (verified.response.status !== 200 || !Array.isArray(verified.payload?.data)) {
    throw new Error(`New production Console Core token failed Model Admin verification: ${verified.response.status} ${JSON.stringify(verified.payload)}`);
  }
  return { token, id: tokenId, oldIds: before.map((entry) => entry.id).filter((id) => id !== tokenId) };
}

const convergence = await requireProductionConvergence();
const access = await resolveAccessAudience();
const adminUserId = await resolvePlatformAdminUserId();
const application = await createOrReconcileApplication();
const audience = await ensureAudience(access.audience);
const administrator = await ensurePlatformAdministrator(adminUserId);
const applicationCredential = await rotateApplicationCredential(application.created, application.initialSecret);
const principal = await ensureCoreExecutor(applicationCredential.secret, adminUserId);
const coreToken = await rotateCoreToken(applicationCredential.secret, principal.id, adminUserId);

persist("LIFESPACE_PRODUCTION_CONSOLE_ACCESS_AUD", access.audience);
persist("LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", adminUserId);
persist("LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_CREDENTIAL", applicationCredential.secret, { secret: true });
persist("LIFESPACE_PRODUCTION_CONSOLE_CORE_BEARER", coreToken.token, { secret: true });
persist("LIFESPACE_PRODUCTION_CONSOLE_CURRENT_CREDENTIAL_ID", applicationCredential.id);
persist("LIFESPACE_PRODUCTION_CONSOLE_OLD_CREDENTIAL_IDS", applicationCredential.oldIds.join(",") || "none");
persist("LIFESPACE_PRODUCTION_CONSOLE_CORE_PRINCIPAL_ID", principal.id);
persist("LIFESPACE_PRODUCTION_CONSOLE_CURRENT_CORE_TOKEN_ID", coreToken.id);
persist("LIFESPACE_PRODUCTION_CONSOLE_OLD_CORE_TOKEN_IDS", coreToken.oldIds.join(",") || "none");

console.log(JSON.stringify({
  ok: true,
  environment: "production",
  contracts: {
    identity: convergence.identity.contractVersion,
    coreKernel: convergence.core.contractVersion,
    identityPlatformAdmin: "0.1.0",
    corePlatformAdmin: "0.1.0",
  },
  schemas: { identity: convergence.identity.schemaVersion, core: convergence.core.schemaVersion },
  access: { domain: ACCESS_DOMAIN, audienceSource: access.source, registered: audience.entry?.status === "active" },
  application: { id: applicationId, created: application.created, scopes: APPLICATION_SCOPES },
  platformAdministrator: { userId: adminUserId, status: administrator.status },
  identityExecutor: { currentCredentialId: applicationCredential.id, supersededCredentialCount: applicationCredential.oldIds.length, plaintextLogged: false },
  coreExecutor: { principalId: principal.id, currentTokenId: coreToken.id, supersededTokenCount: coreToken.oldIds.length, scopes: CORE_EXECUTOR_SCOPES, plaintextLogged: false },
  businessDataTouched: false,
  coreIdentityDeploymentPerformed: false,
}, null, 2));
