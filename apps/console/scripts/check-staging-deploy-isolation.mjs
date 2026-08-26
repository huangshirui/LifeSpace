import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const deployWorkflowUrl = new URL("../../../.github/workflows/lifespace-console-staging-deploy.yml", import.meta.url);
const deployWorkflowPath = fileURLToPath(deployWorkflowUrl);
const deploySource = readFileSync(deployWorkflowUrl, "utf8");

const deployRequired = [
  "workflow_dispatch:",
  "pnpm --filter @lifespace/console check",
  "https://auth-staging.aisr.online/api/v1/status",
  "https://core-staging.aisr.online/api/v1/status",
  "CLOUDFLARE_ENV=staging pnpm exec vite build",
  "pnpm exec wrangler deploy",
  "lifespace-staging.aisr.online",
];

for (const token of deployRequired) {
  if (!deploySource.includes(token)) throw new Error(`${deployWorkflowPath} must include ${token}`);
}

const deployForbidden = [
  ["automatic push deployment", /^\s*push:\s*$/mu],
  ["Core migration", /db:migrate|core-migrations/iu],
  ["Core deployment", /apps\/core[^\n]*wrangler deploy|core-deploy/iu],
  ["Identity migration", /identity-migrations/iu],
  ["Identity deployment", /apps\/identity[^\n]*wrangler deploy|identity-deploy/iu],
  ["bootstrap authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["Console provisioning mutation", /prepare-staging-console-(?:admin|shell)/iu],
  ["secret replacement file", /--secrets-file/iu],
  ["production deployment target", /CLOUDFLARE_ENV=production|lifespace-console-production|lifespace\.aisr\.online/iu],
];

for (const [label, pattern] of deployForbidden) {
  if (pattern.test(deploySource)) throw new Error(`${deployWorkflowPath} violates Console-only staging isolation: ${label}`);
}

const acceptanceWorkflowUrl = new URL("../../../.github/workflows/lifespace-console-staging-acceptance.yml", import.meta.url);
const acceptanceWorkflowPath = fileURLToPath(acceptanceWorkflowUrl);
const acceptanceSource = readFileSync(acceptanceWorkflowUrl, "utf8");

const acceptanceRequired = [
  "workflow_dispatch:",
  "environment: staging",
  "LIFESPACE_STAGING_BOOTSTRAP_SECRET",
  "https://auth-staging.aisr.online",
  "https://core-staging.aisr.online",
  "node apps/console/scripts/verify-staging-control-plane.mjs",
];

for (const token of acceptanceRequired) {
  if (!acceptanceSource.includes(token)) throw new Error(`${acceptanceWorkflowPath} must include ${token}`);
}

const acceptanceForbidden = [
  ["automatic push acceptance", /^\s*push:\s*$/mu],
  ["pull-request-triggered acceptance", /^\s*pull_request(?:_target)?:\s*$/mu],
  ["scheduled acceptance", /^\s*schedule:\s*$/mu],
  ["reusable automatic acceptance", /^\s*workflow_call:\s*$/mu],
  ["production Console target", /CLOUDFLARE_ENV=production|lifespace-console-production|https:\/\/lifespace\.aisr\.online/iu],
  ["production Core target", /https:\/\/core\.aisr\.online/iu],
  ["production Identity target", /https:\/\/auth\.aisr\.online/iu],
];

for (const [label, pattern] of acceptanceForbidden) {
  if (pattern.test(acceptanceSource)) throw new Error(`${acceptanceWorkflowPath} violates staging acceptance isolation: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  deployWorkflow: ".github/workflows/lifespace-console-staging-deploy.yml",
  acceptanceWorkflow: ".github/workflows/lifespace-console-staging-acceptance.yml",
  manualOnly: true,
  coreIdentityMutationAbsentFromDeploy: true,
  bootstrapAuthorityAbsentFromDeploy: true,
  acceptanceStagingOnly: true,
  productionTargetAbsent: true,
}));
