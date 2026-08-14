import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { PRODUCTION_PROVING_MODELS, assertProductionServiceUrl } from "./production-expectations.mjs";
import { boundedProbeLabel } from "./production-probe-label.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

assertProductionServiceUrl(identityBase, "identity");
assertProductionServiceUrl(coreBase, "core");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");

const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const probeId = `${runId}_${runAttempt}`;
const applicationId = `app_production_model_probe_${probeId}`;
const probeLabel = boundedProbeLabel("Phase6 model probe", probeId, 50);

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runIdentitySql(sql) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd: IDENTITY_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) throw new Error(`Identity production D1 cleanup failed: ${output}`);
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

let userId = "";
let servicePrincipalId = "";
let serviceTokenId = "";
let applicationSecret = "";
try {
  const app = await jsonRequest(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: bootstrapSecret,
    body: {
      id: applicationId,
      name: probeLabel,
      clientType: "service",
      allowedScopes: ["models:manage"],
      trustedBackend: true,
      accessTokenTtlSeconds: 900,
    },
  });
  applicationSecret = app.payload?.data?.clientSecret ?? "";
  if (app.response.status !== 201 || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`Production Model Admin probe application creation failed: ${app.response.status} ${JSON.stringify(app.payload)}`);
  }
  mask(applicationSecret);

  const user = await jsonRequest(identityBase, "/internal/v1/users", {
    method: "POST",
    bearer: applicationSecret,
    body: { displayName: probeLabel },
  });
  userId = user.payload?.data?.id ?? "";
  if (user.response.status !== 201 || !userId.startsWith("usr_")) {
    throw new Error(`Production Model Admin probe user creation failed: ${user.response.status} ${JSON.stringify(user.payload)}`);
  }

  const principal = await jsonRequest(identityBase, "/api/v1/service-principals", {
    method: "POST",
    bearer: applicationSecret,
    body: {
      displayName: probeLabel,
      description: "Ephemeral Phase 6 production verification principal",
      maxScopes: ["models:manage"],
      createdByUserId: userId,
    },
  });
  servicePrincipalId = principal.payload?.data?.id ?? "";
  if (principal.response.status !== 201 || !servicePrincipalId.startsWith("svc_")) {
    throw new Error(`Production Model Admin service principal creation failed: ${principal.response.status} ${JSON.stringify(principal.payload)}`);
  }

  const token = await jsonRequest(identityBase, `/api/v1/service-principals/${encodeURIComponent(servicePrincipalId)}/tokens`, {
    method: "POST",
    bearer: applicationSecret,
    body: {
      label: probeLabel,
      scopes: ["models:manage"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdByUserId: userId,
    },
  });
  serviceTokenId = token.payload?.data?.id ?? "";
  const serviceBearer = token.payload?.data?.token ?? "";
  if (token.response.status !== 201 || !serviceTokenId.startsWith("sat_") || !serviceBearer.startsWith("lsp_pat_")) {
    throw new Error(`Production Model Admin service token creation failed: ${token.response.status} ${JSON.stringify(token.payload)}`);
  }
  mask(serviceBearer);

  const models = await jsonRequest(coreBase, "/api/v1/model-admin/models", { bearer: serviceBearer });
  if (models.response.status !== 200 || !Array.isArray(models.payload?.data)) {
    throw new Error(`Production Model Admin list failed; Core↔Identity service authentication may be invalid: ${models.response.status} ${JSON.stringify(models.payload)}`);
  }
  const actualModels = new Map(models.payload.data.map((model) => [model.key, model]));
  for (const expected of PRODUCTION_PROVING_MODELS) {
    const actual = actualModels.get(expected.key);
    if (!actual || actual.state !== "published" || Number(actual.version) !== expected.version || actual.schemaHash !== expected.hash) {
      throw new Error(`Production published model ${expected.key} does not match the accepted contract: ${JSON.stringify(actual)}`);
    }
  }

  const contract = await jsonRequest(coreBase, "/api/v1/model-admin/contracts/active", { bearer: serviceBearer });
  const active = contract.payload?.data;
  if (contract.response.status !== 200 || active?.id !== profile.contracts.modelContract) {
    throw new Error(`Production active Model Contract mismatch: expected ${profile.contracts.modelContract}, got ${active?.id ?? contract.response.status}`);
  }
  const contractModels = new Map((active?.manifest?.models ?? []).map((model) => [model.key, model]));
  for (const expected of PRODUCTION_PROVING_MODELS) {
    const model = contractModels.get(expected.key);
    if (!model || Number(model.version) !== expected.version) {
      throw new Error(`Production active Model Contract is missing accepted ${expected.key} v${expected.version}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    serviceAuthentication: "lsp_pat_to_core_introspection_passed",
    modelAdminServiceBoundary: true,
    activeModelContract: active.id,
    models: Object.fromEntries(PRODUCTION_PROVING_MODELS.map((model) => [model.key, model.version])),
    probeAuthorityEphemeral: true,
  }, null, 2));
} finally {
  // The probe intentionally leaves no application, user, principal or token authority behind.
  // Delete child rows first because the Identity schema uses foreign keys without ON DELETE CASCADE.
  if (servicePrincipalId) {
    runIdentitySql(`DELETE FROM service_api_tokens WHERE principal_id=${sqlString(servicePrincipalId)}`);
    runIdentitySql(`DELETE FROM service_oauth_credentials WHERE principal_id=${sqlString(servicePrincipalId)}`);
    runIdentitySql(`DELETE FROM service_principals WHERE id=${sqlString(servicePrincipalId)}`);
  }
  if (applicationId) {
    runIdentitySql(`DELETE FROM application_credentials WHERE application_id=${sqlString(applicationId)}`);
    runIdentitySql(`DELETE FROM applications WHERE id=${sqlString(applicationId)}`);
  }
  if (userId) runIdentitySql(`DELETE FROM users WHERE id=${sqlString(userId)}`);
}
