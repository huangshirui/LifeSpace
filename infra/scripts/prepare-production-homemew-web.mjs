import crypto from "node:crypto";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const confirmation = process.env.HOMEMEW_WEB_PRODUCTION_CONFIRMATION ?? "";
const accessDomain = (process.env.HOMEMEW_WEB_PRODUCTION_DOMAIN ?? "homemew.aisr.online").trim();
const loginPath = "/api/v1/login/wechat";
const workerName = (process.env.HOMEMEW_WEB_PRODUCTION_WORKER_NAME ?? "homemew-web-production").trim();
const coreDatabaseName = (process.env.LIFESPACE_PRODUCTION_CORE_D1_NAME ?? "lifespace-core").trim();
const webApplicationId = (process.env.LIFESPACE_PRODUCTION_WEB_APPLICATION_ID ?? "app_homemew_web_production").trim();
const webApplicationName = (process.env.LIFESPACE_PRODUCTION_WEB_APPLICATION_NAME ?? "HomeMew Web production").trim();
const integrationsApplicationId = (process.env.LIFESPACE_PRODUCTION_INTEGRATIONS_APPLICATION_ID ?? "app_homemew_integrations_production").trim();
const integrationsApplicationName = (process.env.LIFESPACE_PRODUCTION_INTEGRATIONS_APPLICATION_NAME ?? "HomeMew integrations production").trim();

const REQUIRED_IDENTITY_CONTRACT = "0.5.0";
const REQUIRED_CORE_CONTRACT = "0.13.0";
const TOKEN_TTL_SECONDS = 900;
const WEB_SCOPES = [
  "profile:read",
  "profile:write",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "grants:manage",
  "resources:read",
  "resources:write",
  "creation-drafts:read",
  "creation-drafts:write",
];
const INTEGRATIONS_SCOPES = ["resources:read", "resources:write"];
const WEB_MODEL_ACCESS = new Map([
  ["event", "write"],
  ["task", "write"],
  ["day_record", "write"],
  ["wish", "write"],
]);
const INTEGRATIONS_MODEL_ACCESS = new Map([
  ["event", "write"],
  ["task", "write"],
  ["day_record", "write"],
]);
const REQUIRED_WORKER_SECRETS = [
  "LIFESPACE_APPLICATION_CREDENTIAL",
  "WEB_SESSION_SECRET",
  "LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL",
];

for (const [name, value] of Object.entries({
  LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET: bootstrapSecret,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: apiToken,
  HOMEMEW_WEB_PRODUCTION_DOMAIN: accessDomain,
  HOMEMEW_WEB_PRODUCTION_WORKER_NAME: workerName,
  LIFESPACE_PRODUCTION_WEB_APPLICATION_ID: webApplicationId,
  LIFESPACE_PRODUCTION_INTEGRATIONS_APPLICATION_ID: integrationsApplicationId,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (confirmation !== "PROVISION_HOMEMEW_WEB_PRODUCTION") {
  throw new Error("HOMEMEW_WEB_PRODUCTION_CONFIRMATION must equal PROVISION_HOMEMEW_WEB_PRODUCTION");
}
if (bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
}
if (!/^app_[0-9A-Za-z_-]+$/u.test(webApplicationId) || !/^app_[0-9A-Za-z_-]+$/u.test(integrationsApplicationId)) {
  throw new Error("LifeSpace application identifiers must use app_* identifiers");
}
if (webApplicationId === integrationsApplicationId) throw new Error("Web and integrations application IDs must be different");

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function identity(path, { method = "GET", bearer, body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { "x-bootstrap-secret": bootstrapSecret }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await parseResponse(response) };
}

async function cloudflare(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await parseResponse(response);
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors.map((entry) => entry?.message).filter(Boolean).join("; ")
      : "";
    throw new Error(`Cloudflare request failed: ${method} ${path} -> HTTP ${response.status}${messages ? ` (${messages})` : ""}`);
  }
  return payload;
}

async function requireProductionRuntime() {
  const [identityStatusResponse, coreStatusResponse] = await Promise.all([
    fetch(`${identityBase}/api/v1/status`),
    fetch(`${coreBase}/api/v1/status`),
  ]);
  const identityStatus = await parseResponse(identityStatusResponse);
  const coreStatus = await parseResponse(coreStatusResponse);

  if (identityStatusResponse.status !== 200
      || identityStatus?.data?.environment !== "production"
      || identityStatus?.data?.contractVersion !== REQUIRED_IDENTITY_CONTRACT) {
    throw new Error(`Identity production must be environment=production / contract=${REQUIRED_IDENTITY_CONTRACT}`);
  }
  if (coreStatusResponse.status !== 200
      || coreStatus?.data?.environment !== "production"
      || coreStatus?.data?.contractVersion !== REQUIRED_CORE_CONTRACT) {
    throw new Error(`Core production must be environment=production / contract=${REQUIRED_CORE_CONTRACT}`);
  }
  return {
    identitySchemaVersion: identityStatus.data.schemaVersion,
    coreSchemaVersion: coreStatus.data.schemaVersion,
  };
}

async function requireProductionAccess() {
  const listed = await cloudflare("/access/apps?per_page=100");
  const apps = Array.isArray(listed.result) ? listed.result : [];
  const root = apps.find((app) => app?.type === "self_hosted" && app?.domain === accessDomain);
  if (!root?.id || typeof root.aud !== "string" || !root.aud.trim()) {
    throw new Error(`Production Access application must exist before LifeSpace provisioning: ${accessDomain}`);
  }
  const rootPolicies = await cloudflare(`/access/apps/${encodeURIComponent(root.id)}/policies?per_page=100`);
  if (!rootPolicies.result?.some((policy) => policy?.decision === "allow")) {
    throw new Error("Production Access root application must contain an Allow policy");
  }

  const publicDomain = `${accessDomain}${loginPath}`;
  const publicApp = apps.find((app) => app?.type === "self_hosted" && app?.domain === publicDomain);
  if (!publicApp?.id) throw new Error(`Mini Program login Access bypass application is missing: ${publicDomain}`);
  const publicPolicies = await cloudflare(`/access/apps/${encodeURIComponent(publicApp.id)}/policies?per_page=100`);
  const bypass = publicPolicies.result?.some((policy) => policy?.decision === "bypass"
    && Array.isArray(policy.include)
    && policy.include.some((entry) => entry?.everyone));
  if (!bypass) throw new Error("Mini Program login Access application must contain an Everyone bypass policy");
  return { audience: root.aud.trim(), rootApplicationId: root.id, publicApplicationId: publicApp.id };
}

async function listApplicationCredentials(applicationId) {
  const result = await identity(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`);
  if (result.response.status !== 200 || !Array.isArray(result.payload?.data)) {
    throw new Error(`Could not list LifeSpace application credentials for ${applicationId}: HTTP ${result.response.status}`);
  }
  return result.payload.data;
}

async function identifyCreatedCredential(applicationId, secret) {
  const active = (await listApplicationCredentials(applicationId))
    .filter((entry) => entry?.status === "active" && entry?.revokedAt == null);
  const matches = active.filter((entry) => entry?.secretSuffix === secret.slice(-8));
  if (matches.length !== 1) throw new Error(`Could not identify freshly-created credential for ${applicationId}`);
  return { credentialId: matches[0].id, active };
}

async function ensureApplication({ applicationId, applicationName, clientType, allowedScopes }) {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
  let lookup = await identity(path);
  let credential = "";
  let credentialId = "";

  if (lookup.response.status === 404) {
    const created = await identity("/bootstrap/v1/applications", {
      method: "POST",
      body: {
        id: applicationId,
        name: applicationName,
        clientType,
        allowedScopes,
        trustedBackend: true,
        accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
      },
    });
    credential = created.payload?.data?.clientSecret ?? "";
    if (created.response.status !== 201 || !credential.startsWith("lsa_")) {
      throw new Error(`Could not create LifeSpace application ${applicationId}: HTTP ${created.response.status}`);
    }
    mask(credential);
    const identified = await identifyCreatedCredential(applicationId, credential);
    credentialId = identified.credentialId;
    lookup = await identity(path);
  } else if (lookup.response.status === 200) {
    const current = lookup.payload?.data;
    if (current?.clientType !== clientType || current?.trustedBackend !== true) {
      throw new Error(`Existing ${applicationId} has incompatible immutable application type`);
    }
    const patch = {};
    if (current.name !== applicationName) patch.name = applicationName;
    if (!sameArray(current.allowedScopes, allowedScopes)) patch.allowedScopes = allowedScopes;
    if (current.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
    if (current.status !== "active") patch.status = "active";
    if (Object.keys(patch).length) {
      const updated = await identity(path, { method: "PATCH", body: patch });
      if (updated.response.status !== 200) {
        throw new Error(`Could not reconcile LifeSpace application ${applicationId}: HTTP ${updated.response.status}`);
      }
    }

    const replacement = await identity(`${path}/credentials`, { method: "POST" });
    credential = replacement.payload?.data?.clientSecret ?? "";
    credentialId = replacement.payload?.data?.id ?? "";
    if (replacement.response.status !== 201 || !credential.startsWith("lsa_") || !credentialId.startsWith("apc_")) {
      throw new Error(`Could not rotate LifeSpace application credential for ${applicationId}: HTTP ${replacement.response.status}`);
    }
    mask(credential);
  } else {
    throw new Error(`Could not read LifeSpace application ${applicationId}: HTTP ${lookup.response.status}`);
  }

  const current = lookup.payload?.data;
  if (lookup.response.status !== 200 || current?.id !== applicationId || current?.status !== "active") {
    throw new Error(`LifeSpace application ${applicationId} did not converge to active state`);
  }
  const active = (await listApplicationCredentials(applicationId))
    .filter((entry) => entry?.status === "active" && entry?.revokedAt == null);
  const oldCredentialIds = active.filter((entry) => entry.id !== credentialId).map((entry) => entry.id);
  return { credential, credentialId, oldCredentialIds };
}

async function ensureWebAudience(audience) {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(webApplicationId)}/access-audiences`;
  const listed = await identity(path);
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`Could not list production Web Access audiences: HTTP ${listed.response.status}`);
  }
  const existing = listed.payload.data.find((entry) => entry?.audience === audience && entry?.status === "active");
  if (existing) return existing;
  const created = await identity(path, { method: "POST", body: { audience } });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== audience) {
    throw new Error(`Could not register production Web Access audience: HTTP ${created.response.status}`);
  }
  return created.payload.data;
}

async function findCoreDatabaseId() {
  const payload = await cloudflare("/d1/database?per_page=1000");
  const database = payload.result?.find((entry) => entry?.name === coreDatabaseName);
  if (!database?.uuid) throw new Error(`Required production Core D1 database does not exist: ${coreDatabaseName}`);
  return database.uuid;
}

async function d1Query(databaseId, sql, params = []) {
  const payload = await cloudflare(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    body: { sql, params },
  });
  const results = Array.isArray(payload.result) ? payload.result : [];
  if (!results.length || results.some((entry) => entry?.success === false)) {
    throw new Error(`D1 query failed for ${coreDatabaseName}`);
  }
  return results.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

async function reconcileModelAccess(databaseId, applicationId, modelAccess) {
  const now = new Date().toISOString();
  for (const [modelKey, maxAccess] of modelAccess) {
    await d1Query(databaseId, `INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,'service','svc_lifespace_bootstrap',?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`,
    [applicationId, modelKey, maxAccess, now, now]);
  }
  const allowed = [...modelAccess.keys()];
  const placeholders = allowed.map(() => "?").join(",");
  await d1Query(databaseId,
    `DELETE FROM application_model_access WHERE application_id=? AND model_key NOT IN (${placeholders})`,
    [applicationId, ...allowed]);
  const rows = await d1Query(databaseId,
    "SELECT model_key,max_access FROM application_model_access WHERE application_id=? ORDER BY model_key",
    [applicationId]);
  const expected = [...modelAccess.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (rows.length !== expected.length
      || expected.some(([modelKey, access], index) => rows[index]?.model_key !== modelKey || rows[index]?.max_access !== access)) {
    throw new Error(`Application × Model Access did not converge for ${applicationId}`);
  }
  return Object.fromEntries(expected);
}

async function workerSecretNames() {
  const payload = await cloudflare(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`);
  return new Set((payload.result ?? []).map((entry) => entry?.name).filter(Boolean));
}

async function putWorkerSecret(name, text) {
  mask(text);
  await cloudflare(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`, {
    method: "PUT",
    body: { name, text, type: "secret_text" },
  });
}

async function installWorkerSecrets(webCredential, integrationsCredential) {
  const before = await workerSecretNames();
  await putWorkerSecret("LIFESPACE_APPLICATION_CREDENTIAL", webCredential);
  await putWorkerSecret("LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL", integrationsCredential);
  let sessionSecretCreated = false;
  if (!before.has("WEB_SESSION_SECRET")) {
    await putWorkerSecret("WEB_SESSION_SECRET", crypto.randomBytes(48).toString("base64url"));
    sessionSecretCreated = true;
  }
  const after = await workerSecretNames();
  const missing = REQUIRED_WORKER_SECRETS.filter((name) => !after.has(name));
  if (missing.length) throw new Error(`Required HomeMew production Worker secrets are missing: ${missing.join(", ")}`);
  return { sessionSecretCreated };
}

async function verifyIntegrationsCredential(credential) {
  const listed = await identity("/api/v1/service-principals", { bearer: credential });
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`Production integrations application credential cannot manage its service principals: HTTP ${listed.response.status}`);
  }
}

async function revokeSuperseded(applicationId, credentialIds) {
  for (const credentialId of credentialIds) {
    const result = await identity(
      `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
    );
    if (result.response.status !== 204 && result.response.status !== 404) {
      throw new Error(`Could not revoke superseded credential for ${applicationId}: HTTP ${result.response.status}`);
    }
  }
}

const runtime = await requireProductionRuntime();
const access = await requireProductionAccess();
const webApplication = await ensureApplication({
  applicationId: webApplicationId,
  applicationName: webApplicationName,
  clientType: "web",
  allowedScopes: WEB_SCOPES,
});
await ensureWebAudience(access.audience);
const integrationsApplication = await ensureApplication({
  applicationId: integrationsApplicationId,
  applicationName: integrationsApplicationName,
  clientType: "service",
  allowedScopes: INTEGRATIONS_SCOPES,
});
const databaseId = await findCoreDatabaseId();
const webModelAccess = await reconcileModelAccess(databaseId, webApplicationId, WEB_MODEL_ACCESS);
const integrationsModelAccess = await reconcileModelAccess(databaseId, integrationsApplicationId, INTEGRATIONS_MODEL_ACCESS);
const worker = await installWorkerSecrets(webApplication.credential, integrationsApplication.credential);
await verifyIntegrationsCredential(integrationsApplication.credential);
await revokeSuperseded(webApplicationId, webApplication.oldCredentialIds);
await revokeSuperseded(integrationsApplicationId, integrationsApplication.oldCredentialIds);

console.log(JSON.stringify({
  ok: true,
  environment: "production",
  runtime,
  access: {
    domain: accessDomain,
    audience: access.audience,
    rootApplicationId: access.rootApplicationId,
    publicLoginApplicationId: access.publicApplicationId,
  },
  webApplication: {
    id: webApplicationId,
    allowedScopes: WEB_SCOPES,
    modelAccess: webModelAccess,
    supersededCredentialsRevoked: webApplication.oldCredentialIds.length,
  },
  integrationsApplication: {
    id: integrationsApplicationId,
    allowedScopes: INTEGRATIONS_SCOPES,
    modelAccess: integrationsModelAccess,
    supersededCredentialsRevoked: integrationsApplication.oldCredentialIds.length,
  },
  worker: {
    name: workerName,
    requiredSecrets: REQUIRED_WORKER_SECRETS,
    sessionSecretCreated: worker.sessionSecretCreated,
  },
  productionOnly: true,
}, null, 2));
