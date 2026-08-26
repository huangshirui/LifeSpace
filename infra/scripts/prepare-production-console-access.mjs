import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRODUCTION_ACCESS_DOMAIN = "lifespace.aisr.online";
export const STAGING_ACCESS_DOMAIN = "lifespace-staging.aisr.online";
export const PRODUCTION_ACCESS_NAME = "LifeSpace Console";

const FORBIDDEN_INCLUDE_RULES = new Set([
  "everyone",
  "any_valid_service_token",
  "service_token",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function applicationDomains(application) {
  if (!isRecord(application)) return [];
  return [
    typeof application.domain === "string" ? application.domain : "",
    ...(Array.isArray(application.self_hosted_domains)
      ? application.self_hosted_domains.filter((value) => typeof value === "string")
      : []),
  ].filter(Boolean);
}

export function matchingApplications(applications, domain) {
  if (!Array.isArray(applications)) return [];
  return applications.filter((application) => applicationDomains(application).includes(domain));
}

function explicitEmailRule(rule) {
  return isRecord(rule)
    && isRecord(rule.email)
    && typeof rule.email.email === "string"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(rule.email.email);
}

export function cloneStrictAllowPolicy(policy, index = 0) {
  if (!isRecord(policy)) throw new Error("Access policy must be an object");
  if (policy.decision !== "allow") {
    throw new Error(`Access bootstrap only accepts allow policies; got ${String(policy.decision)}`);
  }

  const include = Array.isArray(policy.include) ? policy.include : [];
  if (include.length === 0) throw new Error("Access bootstrap requires at least one include rule");

  let explicitEmailCount = 0;
  for (const rule of include) {
    if (!isRecord(rule)) throw new Error("Access include rules must be objects");
    const keys = Object.keys(rule);
    if (keys.some((key) => FORBIDDEN_INCLUDE_RULES.has(key))) {
      throw new Error(`Access bootstrap rejects broad/non-human include rule: ${keys.join(",")}`);
    }
    if (explicitEmailRule(rule)) explicitEmailCount += 1;
  }
  if (explicitEmailCount === 0) {
    throw new Error("Access bootstrap requires an explicit email include rule so production cannot become broader than the accepted owner-only staging policy");
  }

  const name = typeof policy.name === "string" && policy.name.trim()
    ? policy.name.trim()
    : `LifeSpace Console owner policy ${index + 1}`;

  const cloned = {
    name,
    decision: "allow",
    precedence: index + 1,
    include: cloneJson(include),
  };

  for (const key of [
    "exclude",
    "require",
    "session_duration",
    "purpose_justification_required",
    "purpose_justification_prompt",
    "isolation_required",
    "approval_required",
    "approval_groups",
    "mfa_config",
  ]) {
    if (policy[key] !== undefined && policy[key] !== null) cloned[key] = cloneJson(policy[key]);
  }

  return cloned;
}

export function buildProductionAccessApplication(stagingApplication, stagingPolicies) {
  if (!isRecord(stagingApplication)) throw new Error("Staging Access application is invalid");
  if (stagingApplication.type !== "self_hosted") {
    throw new Error(`Expected staging Console Access type self_hosted, got ${String(stagingApplication.type)}`);
  }
  const policies = (Array.isArray(stagingPolicies) ? stagingPolicies : [])
    .sort((left, right) => Number(left?.precedence ?? 0) - Number(right?.precedence ?? 0))
    .map((policy, index) => cloneStrictAllowPolicy(policy, index));
  if (policies.length === 0) throw new Error("Staging Console Access application has no policies to clone");

  const body = {
    name: PRODUCTION_ACCESS_NAME,
    type: "self_hosted",
    domain: PRODUCTION_ACCESS_DOMAIN,
    session_duration: typeof stagingApplication.session_duration === "string" && stagingApplication.session_duration.trim()
      ? stagingApplication.session_duration.trim()
      : "24h",
    policies,
  };

  if (Array.isArray(stagingApplication.allowed_idps) && stagingApplication.allowed_idps.length > 0) {
    const allowedIdps = stagingApplication.allowed_idps.filter((value) => typeof value === "string" && value.trim());
    if (allowedIdps.length !== stagingApplication.allowed_idps.length) throw new Error("Staging Access allowed_idps contains invalid values");
    body.allowed_idps = [...allowedIdps];
    if (stagingApplication.auto_redirect_to_identity === true) {
      if (allowedIdps.length !== 1) throw new Error("Staging Access auto_redirect_to_identity requires exactly one allowed IdP");
      body.auto_redirect_to_identity = true;
    }
  }

  if (typeof stagingApplication.app_launcher_visible === "boolean") {
    body.app_launcher_visible = stagingApplication.app_launcher_visible;
  }

  return body;
}

export function assertExistingProductionAccess(application, policies) {
  if (!isRecord(application) || application.type !== "self_hosted") {
    throw new Error("Existing production Console Access application must be self_hosted");
  }
  if (!applicationDomains(application).includes(PRODUCTION_ACCESS_DOMAIN)) {
    throw new Error("Existing production Console Access application does not protect the expected hostname");
  }
  const audience = typeof application.aud === "string" ? application.aud.trim() : "";
  if (!audience || /\s/u.test(audience)) throw new Error("Existing production Console Access application has an invalid audience");
  const safePolicies = Array.isArray(policies) ? policies : [];
  if (safePolicies.length === 0) throw new Error("Existing production Console Access application has no policies");
  safePolicies.forEach((policy, index) => cloneStrictAllowPolicy(policy, index));
  return audience;
}

async function cloudflareRequest(accountId, apiToken, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare Access API ${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

async function listPolicies(accountId, apiToken, applicationId) {
  const result = await cloudflareRequest(
    accountId,
    apiToken,
    `/access/apps/${encodeURIComponent(applicationId)}/policies?per_page=100`,
  );
  if (!Array.isArray(result)) throw new Error("Cloudflare Access policy list returned an invalid result");
  return result;
}

async function main() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const githubEnv = (process.env.GITHUB_ENV ?? "").trim();
  if (!accountId || !apiToken) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  if (!githubEnv) throw new Error("GITHUB_ENV is required to publish the resolved production Access audience");
  console.log(`::add-mask::${apiToken}`);

  const applications = await cloudflareRequest(accountId, apiToken, "/access/apps?per_page=100");
  if (!Array.isArray(applications)) throw new Error("Cloudflare Access application list returned an invalid result");

  const productionMatches = matchingApplications(applications, PRODUCTION_ACCESS_DOMAIN);
  if (productionMatches.length > 1) {
    throw new Error(`Expected at most one production Console Access application, found ${productionMatches.length}`);
  }

  let productionApplication = productionMatches[0] ?? null;
  let created = false;
  if (!productionApplication) {
    const stagingMatches = matchingApplications(applications, STAGING_ACCESS_DOMAIN);
    if (stagingMatches.length !== 1) {
      throw new Error(`Cannot bootstrap production Access: expected exactly one accepted staging Console Access application, found ${stagingMatches.length}`);
    }
    const stagingId = typeof stagingMatches[0]?.id === "string" ? stagingMatches[0].id : "";
    if (!stagingId) throw new Error("Accepted staging Console Access application has no id");

    const stagingApplication = await cloudflareRequest(accountId, apiToken, `/access/apps/${encodeURIComponent(stagingId)}`);
    const stagingPolicies = await listPolicies(accountId, apiToken, stagingId);
    const requestBody = buildProductionAccessApplication(stagingApplication, stagingPolicies);

    productionApplication = await cloudflareRequest(accountId, apiToken, "/access/apps", {
      method: "POST",
      body: requestBody,
    });
    created = true;
  }

  const productionId = typeof productionApplication?.id === "string" ? productionApplication.id : "";
  if (!productionId) throw new Error("Production Console Access application has no id");
  const verifiedApplication = await cloudflareRequest(accountId, apiToken, `/access/apps/${encodeURIComponent(productionId)}`);
  const verifiedPolicies = await listPolicies(accountId, apiToken, productionId);
  const audience = assertExistingProductionAccess(verifiedApplication, verifiedPolicies);

  appendFileSync(githubEnv, `LIFESPACE_PRODUCTION_CONSOLE_ACCESS_AUD=${audience}\n`, "utf8");
  appendFileSync(githubEnv, `LIFESPACE_PRODUCTION_CONSOLE_ACCESS_STATE=${created ? "created" : "existing"}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    domain: PRODUCTION_ACCESS_DOMAIN,
    state: created ? "created-from-accepted-staging-template" : "existing-verified",
    applicationType: "self_hosted",
    policyCount: verifiedPolicies.length,
    explicitOwnerEmailPolicyRequired: true,
    broadEveryonePolicyRejected: true,
    serviceAuthenticationPolicyRejected: true,
    audienceResolved: true,
  }, null, 2));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await main();
