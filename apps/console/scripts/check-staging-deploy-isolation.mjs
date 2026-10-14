import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../../.github/workflows/lifespace-console-staging-deploy.yml", import.meta.url);
const workflowPath = fileURLToPath(workflowUrl);
const workflowSource = readFileSync(workflowUrl, "utf8");

const workflowRequired = [
  "workflow_dispatch:",
  "run_control_plane_acceptance:",
  "external_acceptance_space_id:",
  "if: ${{ inputs.run_control_plane_acceptance }}",
];

for (const token of workflowRequired) {
  if (!workflowSource.includes(token)) throw new Error(`${workflowPath} must include ${token}`);
}

const pinnedCheckoutCount = (workflowSource.match(/ref: \$\{\{ github\.sha \}\}/gu) ?? []).length;
if (pinnedCheckoutCount !== 2) {
  throw new Error(`${workflowPath} must pin both deploy and acceptance checkouts to github.sha`);
}

const workflowForbidden = [
  ["automatic push execution", /^\s*push:\s*$/mu],
  ["pull-request-triggered execution", /^\s*pull_request(?:_target)?:\s*$/mu],
  ["scheduled execution", /^\s*schedule:\s*$/mu],
  ["reusable automatic execution", /^\s*workflow_call:\s*$/mu],
];

for (const [label, pattern] of workflowForbidden) {
  if (pattern.test(workflowSource)) throw new Error(`${workflowPath} violates manual-only staging isolation: ${label}`);
}

const deployStart = workflowSource.indexOf("\n  deploy:\n");
const acceptanceStart = workflowSource.indexOf("\n  acceptance:\n");
if (deployStart < 0 || acceptanceStart < 0 || acceptanceStart <= deployStart) {
  throw new Error(`${workflowPath} must contain ordered deploy and acceptance jobs`);
}
const deploySource = workflowSource.slice(deployStart, acceptanceStart);
const acceptanceSource = workflowSource.slice(acceptanceStart);

const deployRequired = [
  "pnpm --filter @lifespace/console check",
  "https://auth-staging.aisr.online/api/v1/status",
  "https://core-staging.aisr.online/api/v1/status",
  "CLOUDFLARE_ENV=staging pnpm exec vite build",
  "pnpm exec wrangler deploy",
  "lifespace-staging.aisr.online",
];

for (const token of deployRequired) {
  if (!deploySource.includes(token)) throw new Error(`${workflowPath} deploy job must include ${token}`);
}

const deployForbidden = [
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
  if (pattern.test(deploySource)) throw new Error(`${workflowPath} deploy job violates Console-only staging isolation: ${label}`);
}

const acceptanceRequired = [
  "if: ${{ inputs.run_control_plane_acceptance }}",
  "needs: deploy",
  "environment: staging",
  "LIFESPACE_STAGING_BOOTSTRAP_SECRET",
  "https://auth-staging.aisr.online",
  "https://core-staging.aisr.online",
  "node infra/scripts/reconcile-staging-console-space-scope.mjs",
  "node apps/console/scripts/verify-staging-control-plane.mjs",
  "node apps/console/scripts/verify-staging-configuration-center.mjs",
  "node infra/scripts/provision-staging-external-source.mjs",
  "LIFESPACE_EXTERNAL_TARGET_SPACE_ID",
  "LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF",
];

for (const token of acceptanceRequired) {
  if (!acceptanceSource.includes(token)) throw new Error(`${workflowPath} acceptance job must include ${token}`);
}

const acceptanceForbidden = [
  ["Worker deployment during acceptance", /wrangler deploy/iu],
  ["platform migration during acceptance", /db:migrate|core-migrations|identity-migrations/iu],
  ["Core deployment during acceptance", /core-deploy/iu],
  ["Identity deployment during acceptance", /identity-deploy/iu],
  ["production Console target", /CLOUDFLARE_ENV=production|lifespace-console-production|https:\/\/lifespace\.aisr\.online/iu],
  ["production Core target", /https:\/\/core\.aisr\.online/iu],
  ["production Identity target", /https:\/\/auth\.aisr\.online/iu],
];

for (const [label, pattern] of acceptanceForbidden) {
  if (pattern.test(acceptanceSource)) throw new Error(`${workflowPath} acceptance job violates staging acceptance isolation: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  workflow: ".github/workflows/lifespace-console-staging-deploy.yml",
  manualOnly: true,
  acceptanceExplicitOptIn: true,
  coreIdentityMutationAbsentFromDeploy: true,
  bootstrapAuthorityAbsentFromDeploy: true,
  acceptanceReconcilesSpaceManageScope: true,
  acceptanceCoversExternalSourceProvisioning: true,
  acceptanceCoversModelPublishing: true,
  acceptanceCoversApplicationCredentialGovernance: true,
  acceptanceDoesNotDeployPlatformServices: true,
  acceptanceStagingOnly: true,
  productionTargetAbsent: true,
}));
