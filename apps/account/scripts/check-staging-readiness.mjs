// Read-only readiness gate for a controlled owner-triggered Staging rollout.
// It never creates Access Applications, changes DNS, issues credentials or deploys a Worker.
import process from "node:process";
import { pathToFileURL } from "node:url";
import { strictPolicies } from "./prepare-staging-access.mjs";

const ACCOUNT_DOMAIN = "account-staging.aisr.online";
const ACCOUNT_SCRIPT = "lifespace-account-staging";
const EXPECTED_ACCESS_TYPE = "self_hosted";
const EXPECTED_ACCOUNT_APPLICATION = "app_lifespace_account_staging";
const PROTECTED_ISSUER = "https://aisronline.cloudflareaccess.com";

export function inspectAccessApplication(applications) {
  const matches = Array.isArray(applications) ? applications.filter((application) =>
    application?.domain === ACCOUNT_DOMAIN
    || (Array.isArray(application?.self_hosted_domains) && application.self_hosted_domains.includes(ACCOUNT_DOMAIN))
  ) : [];
  if (matches.length !== 1) {
    return { ok: false, code: matches.length ? "DUPLICATE_ACCESS_APPLICATION" : "ACCOUNT_ACCESS_MISSING" };
  }
  const app = matches[0];
  if (app.type !== EXPECTED_ACCESS_TYPE || typeof app.aud !== "string" || !/^[A-Za-z0-9]{30,128}$/u.test(app.aud)) {
    return { ok: false, code: "ACCOUNT_ACCESS_INVALID" };
  }
  return { ok: true, appId: app.id, audience: app.aud, appName: app.name };
}

export function inspectStrictPolicy(policies) {
  try {
    const active = strictPolicies(policies);
    return { ok: true, allowPolicyCount: active.length };
  } catch {
    return { ok: false, code: "ACCOUNT_POLICY_NOT_STRICT_OWNER_EMAIL" };
  }
}

export function inspectStatus(status, expected, service) {
  if (!status || status.environment !== "staging"
    || status.contractVersion !== expected.contractVersion
    || String(status.schemaVersion) !== String(expected.schemaVersion)) {
    return { ok: false, code: service.toUpperCase() + "_VERSION_NOT_CONVERGED" };
  }
  return { ok: true, contractVersion: status.contractVersion, schemaVersion: String(status.schemaVersion) };
}

export async function runStagingOAuthReadiness({ env = process.env, fetcher = fetch } = {}) {
  const { STAGING_EXPECTATIONS } = await import("../../../infra/scripts/staging-expectations.mjs");
  const checks = {};
  const errors = [];
  const token = env.CLOUDFLARE_API_TOKEN || "";
  const account = env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!token || !/^[a-f0-9]{32}$/iu.test(account)) {
    return { ok: false, checks, errors: ["CLOUDFLARE_CREDENTIALS_NOT_CONFIGURED"], mutation: false };
  }
  async function callCloudflare(path) {
    const response = await fetcher("https://api.cloudflare.com/client/v4" + path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.success !== true) {
      throw new Error("CLOUDFLARE_READ_FAILED");
    }
    return result.result;
  }
  try {
    const apps = await callCloudflare("/accounts/" + account + "/access/apps?per_page=100");
    checks.access = inspectAccessApplication(apps);
    if (checks.access.ok) {
      const policies = await callCloudflare("/accounts/" + account + "/access/apps/" + encodeURIComponent(checks.access.appId) + "/policies");
      checks.policy = inspectStrictPolicy(policies);
    }
  } catch { errors.push("CLOUDFLARE_ACCESS_INSPECTION_FAILED"); }
  try {
    const workers = await callCloudflare("/accounts/" + account + "/workers/scripts");
    checks.worker = {
      ok: Array.isArray(workers) && workers.some((script) => script.id === ACCOUNT_SCRIPT),
      script: ACCOUNT_SCRIPT,
    };
  } catch { errors.push("CLOUDFLARE_WORKER_INSPECTION_FAILED"); }
  for (const [service, uri] of [
    ["identity", "https://auth-staging.aisr.online/api/v1/status"],
    ["core", "https://core-staging.aisr.online/api/v1/status"],
  ]) {
    try {
      const response = await fetcher(uri, { headers: { accept: "application/json" } });
      const json = await response.json().catch(() => null);
      checks[service] = response.ok
        ? inspectStatus(json?.data, STAGING_EXPECTATIONS[service], service)
        : { ok: false, code: service.toUpperCase() + "_STATUS_UNAVAILABLE" };
    } catch {
      checks[service] = { ok: false, code: service.toUpperCase() + "_STATUS_UNAVAILABLE" };
    }
  }
  // CF Access issuer/audience must be registered to precisely the Account
  // Application in Identity (private Bootstrap read, not available here).
  checks.identityAccessBinding = {
    ok: false, code: "ACCOUNT_APPLICATION_AUDIENCE_NEEDS_SEPARATE_PRIVATE_VERIFICATION",
    accountApplicationId: EXPECTED_ACCOUNT_APPLICATION,
    issuer: PROTECTED_ISSUER,
  };
  checks.secrets = { ok: false, code: "ACCOUNT_CORE_IDENTITY_SECRET_PROVISION_NEEDS_PRIVATE_VERIFICATION" };
  const ok = !errors.length && Object.values(checks).every((check) => check.ok);
  return { ok, mutation: false, checks, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runStagingOAuthReadiness();
  // Deliberately report only configuration existence, never secret values.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}
