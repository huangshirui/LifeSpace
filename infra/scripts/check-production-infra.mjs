import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = [
  "infra/scripts/provision-production.mjs",
  "infra/scripts/production-expectations.mjs",
  "infra/scripts/resolve-production-d1.mjs",
  "infra/scripts/ensure-production-domains.mjs",
  "infra/scripts/initialize-production-runtime.mjs",
  "infra/scripts/verify-production-http.mjs",
  "infra/scripts/verify-production-cloudflare.mjs",
  "infra/scripts/verify-production-model-admin.mjs",
  "infra/scripts/verify-production-homemew-auth.mjs",
  "infra/scripts/verify-production-db.mjs",
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
  ]],
  ["Identity", identityWrangler, ["\"name\": \"lifespace-identity\"", "\"database_name\": \"lifespace-identity\"", "\"bucket_name\": \"lifespace-assets\"", "\"pattern\": \"auth.aisr.online\""]],
]) {
  for (const token of required) if (!source.includes(token)) throw new Error(`${label} production Wrangler config is missing ${token}`);
}

const workflow = readFileSync(resolve(ROOT, ".github/workflows/production-deploy.yml"), "utf8");
for (const required of [
  "environment: production",
  "phase6_bringup:",
  "provision:",
  "confirmation:",
  "DEPLOY_PRODUCTION",
  "LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET",
  "node infra/scripts/verify-production-db.mjs",
]) {
  if (!workflow.includes(required)) throw new Error(`Production deployment workflow is missing guard/step: ${required}`);
}
if (workflow.includes("homemew-one-shot.mjs")) throw new Error("Production deployment workflow must not invoke HomeMew migration during Phase 6");

const profile = JSON.parse(readFileSync(resolve(ROOT, "infra/homemew-integration-profile.json"), "utf8"));
if (profile.application?.productionId !== "homemew-miniprogram") {
  throw new Error("HomeMew production application ID must remain aligned with Core Application × Model Access");
}
if (profile.application?.allowedUserScopes?.includes("models:manage")) {
  throw new Error("HomeMew production user scope ceiling must not contain models:manage");
}

console.log(JSON.stringify({
  ok: true,
  scripts: scripts.length,
  productionResources: {
    d1: [...expected.d1],
    r2: [...expected.r2],
    queues: [...expected.queues],
    domains: Object.fromEntries(expected.domains),
  },
  homemewProductionApplicationId: profile.application.productionId,
  phase6MigrationInvocationAbsent: true,
}, null, 2));
