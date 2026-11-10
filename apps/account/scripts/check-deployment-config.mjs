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
// Account code deployment must never modify neighboring service Workers or credentials.
// The exceptional owner-confirmed workflow retains the original protected bootstrap.
const ordinary = readFileSync(resolve(root, ".github/workflows/lifespace-account-staging-deploy.yml"), "utf8");
const provisioning = readFileSync(resolve(root, ".github/workflows/lifespace-account-staging-provision.yml"), "utf8");
for(const [name,workflow] of [["routine",ordinary],["provisioning",provisioning]]){
  assert(workflow.includes("workflow_dispatch:") && workflow.includes('test "$GITHUB_ACTOR" = "huangshirui"')
    && workflow.includes('test "$GITHUB_TRIGGERING_ACTOR" = "huangshirui"')
    && workflow.includes('test "$GITHUB_REF_NAME" = "main"'),
  name+" staging workflow must require explicit owner-triggered main");
  assert(workflow.includes("group: lifespace-staging-deploy"),
    name+" workflow must share the platform rollout concurrency lock");
}
assert(ordinary.includes("verify-staging-access.mjs")
  && ordinary.includes("verify-staging-bindings.mjs")
  && ordinary.includes("check-platform-convergence.mjs"),
"Routine Account release must verify current Access, secret binding names and compatible platform versions");
for(const forbidden of [
  "wrangler secret put", "wrangler secret delete", "wrangler versions secret",
  "prepare-staging-access.mjs", "prepare-staging-identity.mjs",
  "verify-staging-credential-rotation.mjs", "LIFESPACE_STAGING_BOOTSTRAP_SECRET",
  "db:migrate:", "OAUTH_CORE_APPROVER_SECRET=", "OAUTH_CORE_APPROVER_SECRET --env",
  "OAUTH_ACCOUNT_APPLICATION_ID --env",
]){
  assert(!ordinary.includes(forbidden),"Routine Account release must not provision or rotate: "+forbidden);
}
const ordinaryDeploys=[...ordinary.matchAll(/(?:wrangler|pnpm) deploy[^\n]*/gu)].map(x=>x[0]);
assert(ordinary.includes("pnpm --dir apps/account exec wrangler deploy --env staging")
  && ordinaryDeploys.length===1 && ordinaryDeploys[0].includes("wrangler deploy --env staging"),
  "Routine Account rollout must contain exactly one Account-only Wrangler deploy");
assert(!ordinary.includes("pnpm --dir apps/core exec wrangler")
  && !ordinary.includes("pnpm --dir apps/identity exec wrangler"),
  "Routine Account workflow must not issue Wrangler commands against Core or Identity");
assert(provisioning.includes('test "$CONFIRM_PROVISION" = "PROVISION_OR_ROTATE_ACCOUNT_STAGING"'),
  "Explicit provisioning and secret rotation must require a separate operator confirmation");
for(const setting of ["OAUTH_ACCOUNT_APPLICATION_ID","OAUTH_ISSUER","OAUTH_CONSENT_URL","OAUTH_CORE_APPROVER_SECRET"]){
  assert(provisioning.includes("wrangler secret put "+setting+" --env staging"),
    "Explicit owner-confirmed provisioning must retain "+setting+" without creating new D1 bindings");
}
assert(provisioning.includes("app_lifespace_account_staging")
  && provisioning.includes("https://auth-staging.aisr.online")
  && provisioning.includes("https://account-staging.aisr.online/oauth/consent")
  && provisioning.includes("prepare-staging-identity.mjs")
  && provisioning.includes("verify-staging-credential-rotation.mjs"),
  "Exceptional staging provisioning must preserve the exact Account identity and rotation gates");
assert(!account.env.production.d1_databases && !account.env.staging.d1_databases,
 "Account must never receive an Identity or Core D1 binding");
console.log("Account Worker staging/production isolation and zero-D1 checks passed");
