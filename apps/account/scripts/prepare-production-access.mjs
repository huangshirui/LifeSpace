// Owner-only first-time Production Account perimeter provisioning.
// No OAuth grant, credential, Worker or database is created by this script.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applicationDomains } from "../../../infra/scripts/prepare-production-console-access.mjs";
import { requireSingle, strictPolicies } from "./prepare-staging-access.mjs";

export const ACCOUNT_PRODUCTION_DOMAIN = "account.aisr.online";
export const ACCOUNT_PRODUCTION_NAME = "LifeSpace Account";
const TEMPLATE_DOMAIN = "lifespace.aisr.online";

function securityShape(policy) {
  const shape = (policy || {});
  return JSON.stringify({
    decision: shape.decision,
    include: shape.include || [],
    exclude: shape.exclude || [],
    require: shape.require || [],
  });
}

export function requireProductionAccountAccess(application, policies, templatePolicies) {
  const domains = new Set(applicationDomains(application));
  if (!application || application.type !== "self_hosted"
    || application.name !== ACCOUNT_PRODUCTION_NAME
    || domains.size !== 1 || !domains.has(ACCOUNT_PRODUCTION_DOMAIN)
    || !/^[a-zA-Z0-9]{30,128}$/u.test(application.aud || "")) {
    throw new Error("Production Account Access is not an isolated protected owner application");
  }
  const current = strictPolicies(policies);
  const baseline = strictPolicies(templatePolicies);
  if (current.length !== baseline.length
    || current.some((p, i) => securityShape(p) !== securityShape(baseline[i]))) {
    throw new Error("Production Account Access policy differs from the protected Production Console owner baseline");
  }
  return application.aud;
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  const envFile = process.env.GITHUB_ENV || "";
  if (!/^[a-f0-9]{32}$/iu.test(accountId) || !token || !envFile
    || process.env.LIFESPACE_PRODUCTION_ACCOUNT_ALLOW_ACCESS_CREATE !== "1") {
    throw new Error("Owner-confirmed Production Account Access creation requires protected credentials");
  }
  const base = "https://api.cloudflare.com/client/v4/accounts/" + accountId;
  async function api(path, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      throw new Error("Cloudflare Production Account Access operation failed: HTTP " + response.status);
    }
    return payload.result;
  }
  const apps = await api("/access/apps?per_page=100");
  if (!Array.isArray(apps)) throw new Error("Cloudflare Access applications response is invalid");
  const template = requireSingle(apps, TEMPLATE_DOMAIN);
  if (!template || template.type !== "self_hosted" || !template.id) {
    throw new Error("Production Console Access owner baseline must exist before Account provisioning");
  }
  const baseline = await api("/access/apps/" + encodeURIComponent(template.id) + "/policies?per_page=100");
  const templatePolicies = strictPolicies(baseline);
  let candidate = requireSingle(apps, ACCOUNT_PRODUCTION_DOMAIN);
  let created = false;
  if (!candidate) {
    const source = await api("/access/apps/" + encodeURIComponent(template.id));
    const body = {
      name: ACCOUNT_PRODUCTION_NAME,
      type: "self_hosted",
      domain: ACCOUNT_PRODUCTION_DOMAIN,
      session_duration: source.session_duration || "24h",
      app_launcher_visible: false,
      policies: templatePolicies,
    };
    if (Array.isArray(source.allowed_idps) && source.allowed_idps.length) {
      body.allowed_idps = [...source.allowed_idps];
    }
    candidate = await api("/access/apps", "POST", body);
    created = true;
  }
  if (!candidate?.id) throw new Error("Production Account Access creation returned no application");
  const details = await api("/access/apps/" + encodeURIComponent(candidate.id));
  const policies = await api("/access/apps/" + encodeURIComponent(candidate.id) + "/policies?per_page=100");
  const audience = requireProductionAccountAccess(details, policies, baseline);
  appendFileSync(envFile, "LIFESPACE_PRODUCTION_ACCOUNT_ACCESS_AUD=" + audience + "\n");
  console.log(JSON.stringify({ ok: true, domain: ACCOUNT_PRODUCTION_DOMAIN,
    state: created ? "created" : "existing", ownerPolicyVerified: true,
    audiencePresent: true, noAccountD1: true, secretValuesLogged: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
