import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  applicationDomains, cloneStrictAllowPolicy,
} from "../../../infra/scripts/prepare-production-console-access.mjs";

export const ACCOUNT_DOMAIN = "account-staging.aisr.online";
const TEMPLATE_DOMAIN = "lifespace-staging.aisr.online";
const ACCOUNT_ACCESS_NAME = "LifeSpace Account Staging";

export function requireSingle(apps, domain) {
  const matching = (Array.isArray(apps) ? apps : []).filter(app => applicationDomains(app).includes(domain));
  if (matching.length > 1) throw new Error("Duplicate Access applications protect " + domain);
  return matching[0] ?? null;
}
export function strictPolicies(policies) {
  const ordered = (Array.isArray(policies) ? policies : []).filter(p => p.decision === "allow")
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  if (ordered.length === 0 || ordered.length !== policies.length) throw new Error("Access policy contains non-allow or is empty");
  return ordered.map((policy, index) => {
    const cloned = cloneStrictAllowPolicy(policy, index);
    // Only owner email, no groups, domains or permissive cross-cutting selectors.
    for (const rule of cloned.include) {
      if (Object.keys(rule).length !== 1 || !rule.email?.email) {
        throw new Error("Account Access accepts only exact email allow conditions");
      }
    }
    return cloned;
  });
}
export function assertAccountAccess(app, policies) {
  // Cloudflare returns the same hostname in both domain and
  // self_hosted_domains. Count distinct hostnames, not API fields.
  const distinctDomains = new Set(applicationDomains(app));
  if (!app || app.type !== "self_hosted"
    || distinctDomains.size !== 1
    || !distinctDomains.has(ACCOUNT_DOMAIN)
    || app.name !== ACCOUNT_ACCESS_NAME
    || typeof app.aud !== "string" || !/^[A-Za-z0-9]{30,128}$/u.test(app.aud)) {
    throw new Error("Staging Account Access application must be isolated and active");
  }
  strictPolicies(policies);
  return app.aud;
}
async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  const envFile = process.env.GITHUB_ENV || "";
  if (!/^[a-f0-9]{32}$/iu.test(accountId) || !token || !envFile) {
    throw new Error("Cloudflare credentials and protected GITHUB_ENV are required");
  }
  async function call(path, { method = "GET", body } = {}) {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + accountId + path, {
      method, headers: { authorization: "Bearer " + token, accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success !== true) {
      throw new Error("Cloudflare Access operation failed: " + path + " (HTTP " + res.status + ")");
    }
    return json.result;
  }
  const all = await call("/access/apps?per_page=100");
  let accountApp = requireSingle(all, ACCOUNT_DOMAIN);
  let created = false;
  if (!accountApp) {
    const template = requireSingle(all, TEMPLATE_DOMAIN);
    if (!template || template.type !== "self_hosted") {
      throw new Error("Reviewed Staging Console owner-only Access template is missing");
    }
    const policies = strictPolicies(await call("/access/apps/" + encodeURIComponent(template.id) + "/policies"));
    const body = {
      name: ACCOUNT_ACCESS_NAME, type: "self_hosted", domain: ACCOUNT_DOMAIN,
      session_duration: template.session_duration || "24h", app_launcher_visible: false,
      policies,
    };
    if (Array.isArray(template.allowed_idps) && template.allowed_idps.length) {
      body.allowed_idps = [...template.allowed_idps];
    }
    accountApp = await call("/access/apps", { method: "POST", body });
    created = true;
  }
  const checked = await call("/access/apps/" + encodeURIComponent(accountApp.id));
  const policies = await call("/access/apps/" + encodeURIComponent(accountApp.id) + "/policies");
  const audience = assertAccountAccess(checked, policies);
  // An Access audience is public configuration, not a secret; still use protected GITHUB_ENV.
  appendFileSync(envFile, "LIFESPACE_STAGING_ACCOUNT_ACCESS_AUD=" + audience + "\n");
  console.log(JSON.stringify({
    ok: true, state: created ? "created" : "verified-existing",
    domain: ACCOUNT_DOMAIN, applicationType: "self_hosted",
    strictOwnerPolicyCount: policies.length, audienceRegistered: false,
    identityApplicationProvisioned: false,
    noProductionChanges: true,
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
