import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const webApplicationId = (process.env.LIFESPACE_STAGING_WEB_APPLICATION_ID ?? "app_homemew_web_staging").trim();
const integrationsApplicationId = (process.env.LIFESPACE_STAGING_INTEGRATIONS_APPLICATION_ID ?? "app_homemew_integrations_staging").trim();
const integrationsApplicationName = (process.env.LIFESPACE_STAGING_INTEGRATIONS_APPLICATION_NAME ?? "HomeMew integrations staging").trim();
const workerName = (process.env.HOMEMEW_WEB_STAGING_WORKER_NAME ?? "homemew-web-staging").trim();
const coreDatabaseName = (process.env.LIFESPACE_STAGING_CORE_D1_NAME ?? "lifespace-core-staging").trim();

const INTEGRATIONS_SECRET_NAME = "LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL";
const WEB_MANAGER_SCOPE = "grants:manage";
const INTEGRATIONS_SCOPES = ["resources:read", "resources:write"];
const MODEL_ACCESS = new Map([
  ["event", "write"],
  ["task", "write"],
  ["day_record", "write"],
]);
const TOKEN_TTL_SECONDS = 900;

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: apiToken,
  LIFESPACE_STAGING_WEB_APPLICATION_ID: webApplicationId,
  LIFESPACE_STAGING_INTEGRATIONS_APPLICATION_ID: integrationsApplicationId,
  HOMEMEW_WEB_STAGING_WORKER_NAME: workerName,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^app_[0-9A-Za-z_-]+$/u.test(webApplicationId) || !/^app_[0-9A-Za-z_-]+$/u.test(integrationsApplicationId)) {
  throw new Error("LifeSpace application identifiers must use app_* identifiers");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function identityRequest(path, { method = "GET", bearer, body } = {}) {
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
    throw new Error(`Cloudflare request failed: ${method} ${path} -> HTTP ${response.status}`);
  }
  return payload;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function ensureWebGrantManagementScope() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(webApplicationId)}`;
  const lookup = await identityRequest(path);
  if (lookup.response.status !== 200 || lookup.payload?.data?.id !== webApplicationId) {
    throw new Error(`HomeMew Web staging application must exist before W4 provisioning: ${lookup.response.status}`);
  }
  const current = lookup.payload.data;
  if (!Array.isArray(current.allowedScopes)) throw new Error("HomeMew Web staging application allowedScopes is invalid");

  const allowedScopes = current.allowedScopes.includes(WEB_MANAGER_SCOPE)
    ? current.allowedScopes
    : [...current.allowedScopes, WEB_MANAGER_SCOPE];
  if (!sameArray(current.allowedScopes, allowedScopes) || current.status !== "active") {
    const patched = await identityRequest(path, {
      method: "PATCH",
      body: { allowedScopes, status: "active" },
    });
    if (patched.response.status !== 200 || !patched.payload?.data?.allowedScopes?.includes(WEB_MANAGER_SCOPE)) {
      throw new Error(`Could not enable ${WEB_MANAGER_SCOPE} for HomeMew Web staging: ${patched.response.status}`);
    }
  }
  return allowedScopes;
}

async function listCredentials(applicationId) {
  const result = await identityRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`);
  if (result.response.status !== 200 || !Array.isArray(result.payload?.data)) {
    throw new Error(`Could not list application credentials for ${applicationId}: ${result.response.status}`);
  }
  return result.payload.data;
}

async function ensureIntegrationsApplication() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(integrationsApplicationId)}`;
  let lookup = await identityRequest(path);
  let credential = "";
  let credentialId = "";

  if (lookup.response.status === 404) {
    const created = await identityRequest("/bootstrap/v1/applications", {
      method: "POST",
      body: {
        id: integrationsApplicationId,
        name: integrationsApplicationName,
        clientType: "service",
        allowedScopes: INTEGRATIONS_SCOPES,
        trustedBackend: true,
        accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
      },
    });
    credential = created.payload?.data?.clientSecret ?? "";
    if (created.response.status !== 201 || !credential.startsWith("lsa_")) {
      throw new Error(`Could not create HomeMew integrations staging application: ${created.response.status}`);
    }
    mask(credential);
    const active = (await listCredentials(integrationsApplicationId)).filter((item) => item?.status === "active" && item?.revokedAt == null);
    const current = active.filter((item) => item?.secretSuffix === credential.slice(-8));
    if (current.length !== 1) throw new Error("Could not identify the initial HomeMew integrations credential");
    credentialId = current[0].id;
    lookup = await identityRequest(path);
  } else if (lookup.response.status === 200) {
    const current = lookup.payload?.data;
    if (current?.clientType !== "service" || current?.trustedBackend !== true) {
      throw new Error(`Existing ${integrationsApplicationId} has incompatible immutable application type`);
    }
    const patch = {};
    if (current.name !== integrationsApplicationName) patch.name = integrationsApplicationName;
    if (!sameArray(current.allowedScopes, INTEGRATIONS_SCOPES)) patch.allowedScopes = INTEGRATIONS_SCOPES;
    if (current.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
    if (current.status !== "active") patch.status = "active";
    if (Object.keys(patch).length) {
      const updated = await identityRequest(path, { method: "PATCH", body: patch });
      if (updated.response.status !== 200) throw new Error(`Could not reconcile ${integrationsApplicationId}: ${updated.response.status}`);
    }
    const replacement = await identityRequest(`${path}/credentials`, { method: "POST" });
    credential = replacement.payload?.data?.clientSecret ?? "";
    credentialId = replacement.payload?.data?.id ?? "";
    if (replacement.response.status !== 201 || !credential.startsWith("lsa_") || !credentialId.startsWith("apc_")) {
      throw new Error(`Could not rotate HomeMew integrations application credential: ${replacement.response.status}`);
    }
    mask(credential);
  } else {
    throw new Error(`Could not read HomeMew integrations staging application: ${lookup.response.status}`);
  }

  const active = (await listCredentials(integrationsApplicationId)).filter((item) => item?.status === "active" && item?.revokedAt == null);
  const oldCredentialIds = active.filter((item) => item.id !== credentialId).map((item) => item.id);
  return { credential, credentialId, oldCredentialIds };
}

async function findCoreDatabaseId() {
  const payload = await cloudflare(`/d1/database?per_page=1000`);
  const database = payload.result?.find((item) => item?.name === coreDatabaseName);
  if (!database?.uuid) throw new Error(`Required staging D1 database does not exist: ${coreDatabaseName}`);
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

async function reconcileModelAccess() {
  const databaseId = await findCoreDatabaseId();
  const now = new Date().toISOString();
  for (const [modelKey, maxAccess] of MODEL_ACCESS) {
    await d1Query(databaseId, `INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,'service','svc_lifespace_bootstrap',?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`,
    [integrationsApplicationId, modelKey, maxAccess, now, now]);
  }
  await d1Query(databaseId,
    "DELETE FROM application_model_access WHERE application_id=? AND model_key NOT IN ('event','task','day_record')",
    [integrationsApplicationId]);
  const rows = await d1Query(databaseId,
    "SELECT model_key,max_access FROM application_model_access WHERE application_id=? ORDER BY model_key",
    [integrationsApplicationId]);
  const expected = [...MODEL_ACCESS.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (rows.length !== expected.length || expected.some(([modelKey, access], index) => rows[index]?.model_key !== modelKey || rows[index]?.max_access !== access)) {
    throw new Error(`HomeMew integrations Application × Model Access did not converge: ${JSON.stringify(rows)}`);
  }
  return Object.fromEntries(expected);
}

async function installWorkerSecret(credential) {
  await cloudflare(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`, {
    method: "PUT",
    body: { name: INTEGRATIONS_SECRET_NAME, text: credential, type: "secret_text" },
  });
  const listed = await cloudflare(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`);
  const names = new Set((listed.result ?? []).map((entry) => entry?.name).filter(Boolean));
  if (!names.has(INTEGRATIONS_SECRET_NAME)) throw new Error(`Worker secret ${INTEGRATIONS_SECRET_NAME} is missing after installation`);
}

async function verifyIntegrationCredential(credential) {
  const listed = await identityRequest("/api/v1/service-principals", { bearer: credential });
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`HomeMew integrations application credential cannot manage its service principals: ${listed.response.status}`);
  }
}

async function revokeOldCredentials(ids) {
  for (const credentialId of ids) {
    const result = await identityRequest(
      `/bootstrap/v1/applications/${encodeURIComponent(integrationsApplicationId)}/credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
    );
    if (result.response.status !== 204 && result.response.status !== 404) {
      throw new Error(`Could not revoke superseded HomeMew integrations credential ${credentialId}: ${result.response.status}`);
    }
  }
}

const identityStatus = await fetch(`${identityBase}/api/v1/status`).then(async (response) => ({ response, payload: await parseResponse(response) }));
if (identityStatus.response.status !== 200 || identityStatus.payload?.data?.environment !== "staging") {
  throw new Error("Refusing to provision HomeMew integrations against a non-staging Identity environment");
}

const webAllowedScopes = await ensureWebGrantManagementScope();
const integrationApplication = await ensureIntegrationsApplication();
const modelAccess = await reconcileModelAccess();
await installWorkerSecret(integrationApplication.credential);
await verifyIntegrationCredential(integrationApplication.credential);
await revokeOldCredentials(integrationApplication.oldCredentialIds);

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  webApplication: {
    id: webApplicationId,
    grantsManageEnabled: webAllowedScopes.includes(WEB_MANAGER_SCOPE),
  },
  integrationsApplication: {
    id: integrationsApplicationId,
    clientType: "service",
    allowedScopes: INTEGRATIONS_SCOPES,
    accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
    modelAccess,
    activeCredentialRotated: true,
    supersededCredentialsRevoked: integrationApplication.oldCredentialIds.length,
  },
  worker: {
    name: workerName,
    secretBinding: INTEGRATIONS_SECRET_NAME,
    configured: true,
  },
  productionUntouched: true,
}, null, 2));
