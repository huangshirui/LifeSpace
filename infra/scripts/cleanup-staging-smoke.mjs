import { execFileSync } from "node:child_process";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const principalId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID ?? "";
const tokenId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_TOKEN_ID ?? "";
const serviceGrantId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_GRANT_ID ?? "";
const userBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);

if (!applicationId) {
  console.log("No staging smoke application was prepared; cleanup is a no-op");
  process.exit(0);
}
// Never allow this privileged cleanup to target a real application or production.
if (identityBase !== "https://auth-staging.aisr.online"
  || !/^app_staging_smoke_[0-9A-Za-z_-]+$/u.test(applicationId)
  || bootstrapSecret.length < 32) {
  throw new Error("Staging smoke Application cleanup requires the canonical staging Identity, a run-scoped test Application, and Bootstrap authority");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runCoreSql(sql) {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--command", sql],
    { cwd: CORE_DIR, env: process.env, stdio: "inherit" },
  );
}

async function bootstrapRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      "x-bootstrap-secret": bootstrapSecret,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function identityRequest(path, { method = "GET", body } = {}) {
  if (!applicationSecret) return null;
  return fetch(`${identityBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${applicationSecret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function coreRequest(path, { method = "GET", body } = {}) {
  if (!userBearer) return null;
  return fetch(`${coreBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${userBearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const warnings = [];
if (userBearer && spaceId && serviceGrantId) {
  try {
    const revokedGrant = await coreRequest(`/api/v1/spaces/${spaceId}/grants/${serviceGrantId}`, { method: "DELETE" });
    if (revokedGrant && revokedGrant.status !== 204 && revokedGrant.status !== 404) warnings.push(`Runtime Service Data Grant revocation returned HTTP ${revokedGrant.status}`);
  } catch (error) {
    warnings.push(`Runtime Service Data Grant revocation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (applicationSecret && principalId && tokenId) {
  try {
    const revoked = await identityRequest(`/api/v1/service-principals/${principalId}/tokens/${tokenId}`, { method: "DELETE" });
    if (revoked && revoked.status !== 204 && revoked.status !== 404) warnings.push(`Service PAT revocation returned HTTP ${revoked.status}`);
  } catch (error) {
    warnings.push(`Service PAT revocation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (applicationSecret && principalId) {
  try {
    const disabled = await identityRequest(`/api/v1/service-principals/${principalId}`, { method: "PATCH", body: { status: "disabled" } });
    if (disabled && disabled.status !== 200 && disabled.status !== 404) warnings.push(`Service principal disable returned HTTP ${disabled.status}`);
  } catch (error) {
    warnings.push(`Service principal disable failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  runCoreSql(`DELETE FROM application_model_access WHERE application_id=${sqlString(applicationId)}`);
} catch (error) {
  warnings.push(`Application×Model access cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
}

// The staging Smoke initializer creates one new trusted Application per run.
// A revoked service token alone cannot retire its long-lived initial lsa_*.
// Only the exact run-scoped Application and uniquely matching credential may
// be altered; failure to identify a credential never authorizes broad revoke.
const bootstrapApplicationPath = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
let applicationDisabled = false;
let applicationAbsent = false;
let applicationCredentialRevoked = false;
if (applicationSecret) {
  try {
    const listed = await bootstrapRequest(`${bootstrapApplicationPath}/credentials`);
    if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
      throw new Error(`Credential list returned HTTP ${listed.response.status}`);
    }
    const matches = listed.payload.data.filter((credential) =>
      credential?.secretSuffix === applicationSecret.slice(-8),
    );
    if (matches.length !== 1 || typeof matches[0].id !== "string") {
      throw new Error(`Expected exactly one smoke credential with this secret suffix; found ${matches.length}`);
    }
    const [credential] = matches;
    if (credential.status === "active" && credential.revokedAt == null) {
      const revoked = await bootstrapRequest(`${bootstrapApplicationPath}/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
      if (revoked.response.status !== 204 && revoked.response.status !== 404) {
        throw new Error(`Credential revoke returned HTTP ${revoked.response.status}`);
      }
      applicationCredentialRevoked = true;
    } else if (credential.status === "revoked") {
      applicationCredentialRevoked = true; // Already revoked on a previous cleanup attempt.
    } else {
      throw new Error(`Smoke credential is not in a cleanable state: ${String(credential.status)}`);
    }
  } catch (error) {
    warnings.push(`Smoke Application credential revocation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Disable the entire test Application even if the client secret was lost or
// credential enumeration failed. A 404 can mean initializer failed before POST.
try {
  const disabled = await bootstrapRequest(bootstrapApplicationPath, { method: "PATCH", body: { status: "disabled" } });
  if (disabled.response.status === 404) applicationAbsent = true;
  else if (disabled.response.status === 200 && disabled.payload?.data?.id === applicationId && disabled.payload?.data?.status === "disabled") applicationDisabled = true;
  else throw new Error(`Application disable returned unexpected HTTP ${disabled.response.status}`);
} catch (error) {
  warnings.push(`Smoke Application disable failed: ${error instanceof Error ? error.message : String(error)}`);
}
if (!applicationSecret && !applicationAbsent) {
  warnings.push("Smoke Application secret unavailable; exact credential revocation could not be verified");
}

console.log(JSON.stringify({
  ok: warnings.length === 0,
  applicationId,
  servicePrincipalDisabled: Boolean(applicationSecret && principalId),
  serviceTokenRevocationAttempted: Boolean(applicationSecret && principalId && tokenId),
  serviceRuntimeGrantRevocationAttempted: Boolean(userBearer && spaceId && serviceGrantId),
  modelAccessCleanupAttempted: true,
  applicationCredentialRevoked,
  applicationDisabled,
  applicationAbsent,
  warnings,
}, null, 2));
if (warnings.length) process.exitCode = 1;

