import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (name) => JSON.parse(readFileSync(resolve(root, "apps", name, "wrangler.jsonc"), "utf8"));
const account = read("account");
const core = read("core");
const identity = read("identity");
function assert(value, message) { if (!value) throw new Error("[account-deployment] " + message); }
function names(entries) { return Object.fromEntries((entries || []).map((v) => [v.binding, v.service])); }
function checkAccountEnvironment(environment, site, related) {
  const config = account.env[environment];
  assert(config && config.name === related.accountWorker, environment + " must use its own Worker");
  assert(config.vars?.ENVIRONMENT === environment, environment + " ENVIRONMENT mismatch");
  assert(config.routes?.length === 1 && config.routes[0].pattern === site
    && config.routes[0].custom_domain === true, environment + " domain must be exactly " + site);
  assert(config.vars?.IDENTITY_BASE_URL === related.identityUrl, environment + " Identity URL mismatch");
  assert(config.vars?.CORE_BASE_URL === related.coreUrl, environment + " Core URL mismatch");
  const serviceBindings = names(config.services);
  assert(Object.keys(serviceBindings).length === 2
    && serviceBindings.IDENTITY === related.identityWorker
    && serviceBindings.CORE === related.coreWorker,
  environment + " must bind only same-environment Identity and Core services");
  for (const key of ["d1_databases", "r2_buckets", "kv_namespaces", "durable_objects", "queues"]) {
    assert(!config[key] && !account[key], "Account must not own " + key);
  }
  assert(core.env[environment]?.name === related.coreWorker, environment + " Core Worker missing");
  assert(identity.env[environment]?.name === related.identityWorker, environment + " Identity Worker missing");
}
checkAccountEnvironment("staging", "account-staging.aisr.online", {
  accountWorker: "lifespace-account-staging",
  identityWorker: "lifespace-identity-staging", identityUrl: "https://auth-staging.aisr.online",
  coreWorker: "lifespace-core-staging", coreUrl: "https://core-staging.aisr.online",
});
checkAccountEnvironment("production", "account.aisr.online", {
  accountWorker: "lifespace-account",
  identityWorker: "lifespace-identity", identityUrl: "https://auth.aisr.online",
  coreWorker: "lifespace-core", coreUrl: "https://core.aisr.online",
});
assert(identity.env.staging.vars?.OAUTH_ACCOUNT_APPLICATION_ID === "app_lifespace_account_staging"
 && core.env.staging.vars?.OAUTH_ACCOUNT_APPLICATION_ID === "app_lifespace_account_staging",
 "Core/Identity Staging must share Account Application identity");
assert(identity.env.staging.vars?.OAUTH_ISSUER === "https://auth-staging.aisr.online"
 && identity.env.staging.vars?.OAUTH_CONSENT_URL === "https://account-staging.aisr.online/oauth/consent",
 "Staging OAuth issuer and Account Consent origin must be pinned");
assert(!account.env.production.d1_databases && !account.env.staging.d1_databases,
 "Account must never receive an Identity or Core D1 binding");
console.log("Account Worker staging/production isolation and zero-D1 checks passed");
