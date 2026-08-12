import { execFileSync } from "node:child_process";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const principalId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID ?? "";
const tokenId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_TOKEN_ID ?? "";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);

if (!applicationId) {
  console.log("No staging smoke application was prepared; cleanup is a no-op");
  process.exit(0);
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

async function request(path, { method = "GET", body } = {}) {
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

const warnings = [];
if (applicationSecret && principalId && tokenId) {
  try {
    const revoked = await request(`/api/v1/service-principals/${principalId}/tokens/${tokenId}`, { method: "DELETE" });
    if (revoked && revoked.status !== 204 && revoked.status !== 404) warnings.push(`Service PAT revocation returned HTTP ${revoked.status}`);
  } catch (error) {
    warnings.push(`Service PAT revocation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (applicationSecret && principalId) {
  try {
    const disabled = await request(`/api/v1/service-principals/${principalId}`, { method: "PATCH", body: { status: "disabled" } });
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

console.log(JSON.stringify({
  ok: warnings.length === 0,
  applicationId,
  servicePrincipalDisabled: Boolean(applicationSecret && principalId),
  serviceTokenRevocationAttempted: Boolean(applicationSecret && principalId && tokenId),
  modelAccessCleanupAttempted: true,
  warnings,
}, null, 2));
if (warnings.length) process.exitCode = 1;
