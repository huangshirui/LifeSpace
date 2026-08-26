import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const workflowPath = fileURLToPath(workflowUrl);
const wranglerPath = fileURLToPath(wranglerUrl);
const workflow = readFileSync(workflowUrl, "utf8");
const wrangler = readFileSync(wranglerUrl, "utf8");

const requiredWorkflow = [
  "workflow_dispatch:",
  "DEPLOY_LIFESPACE_CONSOLE_PRODUCTION",
  "environment: production",
  "statuses: write",
  "lifespace-console-production/deploy",
  "LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET",
  "https://auth.aisr.online",
  "https://core.aisr.online",
  "prepare-production-console-admin.mjs",
  "CLOUDFLARE_ENV=production pnpm exec vite build",
  "pnpm exec wrangler deploy --secrets-file",
  "https://lifespace.aisr.online/",
  "finalize-production-console-admin.mjs",
  "release/lifespace-console-production-20260826",
  "GITHUB_SHA",
  "MAIN_SHA",
];
for (const token of requiredWorkflow) {
  if (!workflow.includes(token)) throw new Error(`${workflowPath} must include ${token}`);
}

const forbiddenWorkflow = [
  ["staging target", /auth-staging\.aisr\.online|core-staging\.aisr\.online|lifespace-staging\.aisr\.online|lifespace-console-staging|CLOUDFLARE_ENV=staging/iu],
  ["D1 migration", /db:migrate|d1\s+migrations\s+apply/iu],
  ["Core Worker deployment", /apps\/core[^\n]*wrangler deploy|core-deploy/iu],
  ["Identity Worker deployment", /apps\/identity[^\n]*wrangler deploy|identity-deploy/iu],
  ["HomeMew command execution", /(?:node|pnpm|npm|npx|wrangler)[^\n]*homemew/iu],
  ["full platform production deploy", /production-deploy\.yml|provision-production\.mjs|initialize-production-runtime\.mjs/iu],
  ["pull-request trigger", /^\s*pull_request(?:_target)?:\s*$/mu],
  ["scheduled trigger", /^\s*schedule:\s*$/mu],
  ["workflow_call trigger", /^\s*workflow_call:\s*$/mu],
];
for (const [label, pattern] of forbiddenWorkflow) {
  if (pattern.test(workflow)) throw new Error(`${workflowPath} violates Console-only production isolation: ${label}`);
}

const pushBlock = /\n\s{2}push:\n\s{4}branches:\n\s{6}- release\/lifespace-console-production-20260826\n/u;
if (!pushBlock.test(workflow)) {
  throw new Error(`${workflowPath} temporary push trigger must be limited to the exact one-time release branch`);
}
if (!workflow.includes('test "$GITHUB_SHA" = "$MAIN_SHA"')) {
  throw new Error(`${workflowPath} one-time release branch must be required to point exactly at current main`);
}

const requiredWrangler = [
  '"production": {',
  '"name": "lifespace-console"',
  '"ENVIRONMENT": "production"',
  '"IDENTITY_BASE_URL": "https://auth.aisr.online"',
  '"CORE_BASE_URL": "https://core.aisr.online"',
  '"pattern": "lifespace.aisr.online"',
  '"binding": "IDENTITY", "service": "lifespace-identity"',
  '"binding": "CORE", "service": "lifespace-core"',
];
for (const token of requiredWrangler) {
  if (!wrangler.includes(token)) throw new Error(`${wranglerPath} production config must include ${token}`);
}

console.log(JSON.stringify({
  ok: true,
  workflow: ".github/workflows/lifespace-console-production-deploy.yml",
  productionConsoleOnly: true,
  productionAccessPreflightRequired: true,
  rolloutStatusObservable: true,
  coreIdentityMigrationAbsent: true,
  coreIdentityDeploymentAbsent: true,
  businessDataMutationAbsent: true,
  temporaryPushRestrictedToExactMainSha: true,
  productionBindingsIsolated: true,
}));
