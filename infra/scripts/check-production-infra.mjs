import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = [
  "infra/scripts/provision-production.mjs",
  "infra/scripts/production-expectations.mjs",
  "infra/scripts/verify-staging-candidate-identity.mjs",
  "infra/scripts/resolve-production-d1.mjs",
  "infra/scripts/ensure-production-domains.mjs",
  "infra/scripts/initialize-production-runtime.mjs",
  "infra/scripts/verify-production-http.mjs",
  "infra/scripts/verify-production-cloudflare.mjs",
  "infra/scripts/verify-production-model-admin.mjs",
];

for (const script of scripts) {
  execFileSync(process.execPath, ["--check", resolve(ROOT, script)], { stdio: "inherit" });
}

const resources = JSON.parse(readFileSync(resolve(ROOT, "infra/production/resources.json"), "utf8"));
const expected = {
  d1: new Set(["lifespace-identity", "lifespace-core"]),
  r2: new Set(["lifespace-assets"]),
  queues: new Set([
    "lifespace-creation-drafts",
    "lifespace-event-deliveries",
    "lifespace-event-deliveries-dlq",
  ]),
  domains: new Map([
    ["auth.aisr.online", "lifespace-identity"],
    ["core.aisr.online", "lifespace-core"],
  ]),
};

function exactSet(label, values, wanted) {
  const actual = new Set(values);
  if (actual.size !== wanted.size || [...wanted].some((value) => !actual.has(value))) {
    throw new Error(`${label} does not match the frozen production resource set: ${JSON.stringify([...actual])}`);
  }
}

function requireTokens(label, source, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) throw new Error(`${label} is missing required guard/step: ${token}`);
  }
}

function forbidTokens(label, source, tokens) {
  for (const token of tokens) {
    if (source.includes(token)) throw new Error(`${label} contains forbidden retired/cross-purpose behavior: ${token}`);
  }
}

exactSet("production D1", (resources.d1 ?? []).map((item) => item.name), expected.d1);
exactSet("production R2", (resources.r2 ?? []).map((item) => item.name), expected.r2);
exactSet("production Queue", (resources.queues ?? []).map((item) => item.name), expected.queues);
const actualDomains = new Map((resources.domains ?? []).map((item) => [item.hostname, item.service]));
if (actualDomains.size !== expected.domains.size || [...expected.domains].some(([host, service]) => actualDomains.get(host) !== service)) {
  throw new Error(`Production domains do not match the frozen platform endpoints: ${JSON.stringify(Object.fromEntries(actualDomains))}`);
}

const coreWrangler = readFileSync(resolve(ROOT, "apps/core/wrangler.jsonc"), "utf8");
const identityWrangler = readFileSync(resolve(ROOT, "apps/identity/wrangler.jsonc"), "utf8");
for (const [label, source, required] of [
  ["Core", coreWrangler, [
    "\"name\": \"lifespace-core\"",
    "\"database_name\": \"lifespace-core\"",
    "\"bucket_name\": \"lifespace-assets\"",
    "\"queue\": \"lifespace-creation-drafts\"",
    "\"queue\": \"lifespace-event-deliveries\"",
    "\"dead_letter_queue\": \"lifespace-event-deliveries-dlq\"",
    "\"pattern\": \"core.aisr.online\"",
    "\"placement\": { \"mode\": \"smart\" }",
  ]],
  ["Identity", identityWrangler, [
    "\"name\": \"lifespace-identity\"",
    "\"database_name\": \"lifespace-identity\"",
    "\"bucket_name\": \"lifespace-assets\"",
    "\"pattern\": \"auth.aisr.online\"",
    "\"placement\": { \"mode\": \"smart\" }",
  ]],
]) {
  requireTokens(`${label} production Wrangler config`, source, required);
}

const productionDeploy = readFileSync(resolve(ROOT, ".github/workflows/production-deploy.yml"), "utf8");
requireTokens("Production deployment workflow", productionDeploy, [
  "environment: production",
  "confirmation:",
  "DEPLOY_PRODUCTION",
  "group: lifespace-production-change",
  "apac_performance:",
  "needs: apac_performance",
  "LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET",
  "ref: ${{ github.sha }}",
  "production deployment must run from main",
  "db:migrate:production",
  "wrangler deploy --env production",
  "node infra/scripts/verify-production-model-admin.mjs",
]);
forbidTokens("Production deployment workflow", productionDeploy, [
  "apac_gate_run_id",
  "verify-production-apac-gate",
  "apac-performance-gate.yml",
  "phase6_bringup",
  "provision-production.mjs",
]);

const productionProvision = readFileSync(resolve(ROOT, ".github/workflows/production-provision.yml"), "utf8");
requireTokens("Production provisioning workflow", productionProvision, [
  "environment: production",
  "confirmation:",
  "PROVISION_PRODUCTION",
  "production provisioning must run from main",
  "ref: ${{ github.sha }}",
  "group: lifespace-production-change",
  "node infra/scripts/provision-production.mjs",
]);
forbidTokens("Production provisioning workflow", productionProvision, [
  "db:migrate:production",
  "wrangler deploy --env production",
  "LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET",
]);

const stagingDeploy = readFileSync(resolve(ROOT, ".github/workflows/staging-deploy.yml"), "utf8");
const stagingProvision = readFileSync(resolve(ROOT, ".github/workflows/staging-provision.yml"), "utf8");
requireTokens("Staging provisioning workflow", stagingProvision, [
  "environment: staging",
  "confirmation:",
  "PROVISION_STAGING",
  "node infra/scripts/provision-staging.mjs",
]);
if (!stagingDeploy.includes("group: lifespace-staging-deploy") || !stagingProvision.includes("group: lifespace-staging-deploy")) {
  throw new Error("Staging deploy and provision workflows must share one concurrency lock");
}

requireTokens("Production APAC prerequisite job", productionDeploy, [
  "apac_performance:",
  "needs: validate",
  "group: lifespace-staging-apac-performance",
  "environment: staging",
  "ref: ${{ github.sha }}",
  "APAC checkout does not match workflow candidate SHA",
  "node infra/scripts/staging-expectations.mjs",
  "node infra/scripts/verify-staging-candidate-identity.mjs",
  "REQUIRE_ACTIVE_MODEL_CONTRACT: \"1\"",
  "node infra/scripts/verify-staging-db.mjs",
  "node infra/scripts/verify-staging-http.mjs",
  "node infra/scripts/verify-staging-apac-performance.mjs",
]);

console.log(JSON.stringify({
  ok: true,
  scripts: scripts.length,
  productionResources: {
    d1: [...expected.d1],
    r2: [...expected.r2],
    queues: [...expected.queues],
    domains: Object.fromEntries(expected.domains),
  },
  phase6ActiveEntrypointAbsent: true,
  deploymentProvisioningSeparated: true,
  stagingProvisioningSeparated: true,
  productionApacGateRequired: true,
  productionApacGateAutomatic: true,
  apacGateCandidateIdentityRequired: true,
}, null, 2));