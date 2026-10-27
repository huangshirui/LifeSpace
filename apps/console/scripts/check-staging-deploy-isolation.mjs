import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../../.github/workflows/lifespace-console-staging-deploy.yml", import.meta.url);
const workflowPath = fileURLToPath(workflowUrl);
const workflowSource = readFileSync(workflowUrl, "utf8");

const workflowRequired = [
  "workflow_dispatch:",
  "run_control_plane_acceptance:",
  "if: ${{ inputs.run_control_plane_acceptance }}",
];

for (const token of workflowRequired) {
  if (!workflowSource.includes(token)) throw new Error(`${workflowPath} must include ${token}`);
}
for (const obsolete of ["external_acceptance_space_id", "provision-staging-external-source.mjs", "LIFESPACE_EXTERNAL_TARGET_SPACE_ID", "LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF"] ) {
  if (workflowSource.includes(obsolete)) throw new Error(`${workflowPath} must not preserve obsolete External Source preprovisioning: ${obsolete}`);
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
  "Console External governance uses `/api/v1/platform-admin/spaces/{spaceId}/external-*`",
  "downstream applications retain the ordinary direct-User Space-scoped External API",
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
  ["Console provisioning mutation", /prepare-staging-console-(?:admin|shell)|reconcile-staging-console-space-scope/iu],
  ["External Source provisioning", /provision-staging-external-source/iu],
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
  "node apps/console/scripts/verify-staging-control-plane.mjs",
  "node apps/console/scripts/verify-staging-space-governance.mjs",
  "node apps/console/scripts/verify-staging-configuration-center.mjs",
  "Created, updated and revoked a temporary Data Grant through `/api/v1/platform-admin/spaces/{spaceId}/grants*`",
  "Console governance uses Platform Admin authority",
  "No provider credential is created, rotated or revoked by this generic control-plane acceptance",
];

for (const token of acceptanceRequired) {
  if (!acceptanceSource.includes(token)) throw new Error(`${workflowPath} acceptance job must include ${token}`);
}

const acceptanceForbidden = [
  ["Worker deployment during acceptance", /wrangler deploy/iu],
  ["platform migration during acceptance", /db:migrate|core-migrations|identity-migrations/iu],
  ["Core deployment during acceptance", /core-deploy/iu],
  ["Identity deployment during acceptance", /identity-deploy/iu],
  ["essential Console scope reconciliation", /reconcile-staging-console-space-scope/iu],
  ["External Source provisioning", /provision-staging-external-source|LIFESPACE_EXTERNAL_TARGET_SPACE_ID|external_acceptance_space_id/iu],
  ["production Console target", /CLOUDFLARE_ENV=production|lifespace-console-production|https:\/\/lifespace\.aisr\.online/iu],
  ["production Core target", /https:\/\/core\.aisr\.online/iu],
  ["production Identity target", /https:\/\/auth\.aisr\.online/iu],
];

for (const [label, pattern] of acceptanceForbidden) {
  if (pattern.test(acceptanceSource)) throw new Error(`${workflowPath} acceptance job violates staging acceptance isolation: ${label}`);
}

const provisionUrl = new URL("../../../.github/workflows/lifespace-console-staging-provision.yml", import.meta.url);
const provisionPath = fileURLToPath(provisionUrl);
const provisionSource = readFileSync(provisionUrl, "utf8");

const provisionRequired = [
  "workflow_dispatch:",
  "Resolve expected staging versions",
  "Verify current Core staging compatibility without mutation",
  "https://core-staging.aisr.online/api/v1/status",
  "Verify current Identity staging compatibility without mutation",
  "https://auth-staging.aisr.online/api/v1/status",
  "prepare-staging-console-shell.mjs",
  "prepare-staging-console-admin.mjs",
  "CLOUDFLARE_ENV=staging pnpm exec vite build",
  "pnpm exec wrangler deploy --secrets-file",
  "Core / Identity deployment: unchanged; this workflow only verified current platform compatibility.",
  "Provider Service Bindings / generated routing: preserved from the canonical platform staging release.",
];

for (const token of provisionRequired) {
  if (!provisionSource.includes(token)) throw new Error(`${provisionPath} must include ${token}`);
}

const provisionForbidden = [
  ["Core migration", /@lifespace\/core[^\n]*db:migrate|core-migrations/iu],
  ["Core deployment", /apps\/core[^\n]*wrangler deploy|core-deploy/iu],
  ["Identity migration", /@lifespace\/identity[^\n]*db:migrate|identity-migrations/iu],
  ["Identity deployment", /apps\/identity[^\n]*wrangler deploy|identity-deploy/iu],
  ["platform custom-domain mutation", /ensure-staging-domains\.mjs/iu],
  ["External provider deployment/topology mutation", /external-provider-deployment\.mjs|EXTERNAL_PROVIDER_ROUTES|EXTERNAL_ADAPTER_NOTION/iu],
  ["production target", /CLOUDFLARE_ENV=production|lifespace-console-production|https:\/\/core\.aisr\.online|https:\/\/auth\.aisr\.online/iu],
];

for (const [label, pattern] of provisionForbidden) {
  if (pattern.test(provisionSource)) throw new Error(`${provisionPath} violates Console provisioning isolation: ${label}`);
}

const platformWorkflow = readFileSync(new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
// A Core/Identity release must never silently alter Console Application scopes.
// First-use and explicit scope changes belong to the separately dispatched
// Console provisioning flow, not the canonical platform staging release.
if (platformWorkflow.includes("reconcile-staging-console-space-scope.mjs")) {
  throw new Error("Canonical platform staging release must not mutate Console Application scopes via Bootstrap");
}
if (!provisionSource.includes("node infra/scripts/prepare-staging-console-admin.mjs")) {
  throw new Error("Explicit Console provisioning must remain the supported path for Application scope convergence");
}

console.log(JSON.stringify({
  ok: true,
  workflow: ".github/workflows/lifespace-console-staging-deploy.yml",
  manualOnly: true,
  acceptanceExplicitOptIn: true,
  coreIdentityMutationAbsentFromDeploy: true,
  bootstrapAuthorityAbsentFromDeploy: true,
  platformReleaseDoesNotMutateConsoleScopes: true,
  explicitConsoleProvisioningOwnsScopeConvergence: true,
  consoleExternalGovernanceUsesPlatformAdmin: true,
  downstreamExternalSelfServiceUsesDirectUserSpaceAuthority: true,
  externalSourcePreprovisionAbsent: true,
  acceptanceCoversModelPublishing: true,
  acceptanceCoversSpaceGrantGovernance: true,
  acceptanceCoversExternalAuthorityBoundary: true,
  acceptanceCoversApplicationCredentialGovernance: true,
  acceptanceDoesNotDeployPlatformServices: true,
  acceptanceStagingOnly: true,
  productionTargetAbsent: true,
  controlPlaneProvisionPreservesPlatformDeployment: true,
  providerRoutingCannotBeClobberedByConsoleProvisioning: true,
}));
