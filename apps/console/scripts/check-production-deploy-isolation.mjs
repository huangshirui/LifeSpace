import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const accessBootstrapUrl = new URL("../../../infra/scripts/prepare-production-console-access.mjs", import.meta.url);
const adminBootstrapUrl = new URL("../../../infra/scripts/resolve-production-console-admin.mjs", import.meta.url);
const workflowPath = fileURLToPath(workflowUrl);
const wranglerPath = fileURLToPath(wranglerUrl);
const accessBootstrapPath = fileURLToPath(accessBootstrapUrl);
const adminBootstrapPath = fileURLToPath(adminBootstrapUrl);
const workflow = readFileSync(workflowUrl, "utf8");
const wrangler = readFileSync(wranglerUrl, "utf8");
const accessBootstrap = readFileSync(accessBootstrapUrl, "utf8");
const adminBootstrap = readFileSync(adminBootstrapUrl, "utf8");

const requiredWorkflow = [
  "workflow_dispatch:",
  "DEPLOY_LIFESPACE_CONSOLE_PRODUCTION",
  "environment: production",
  "statuses: write",
  "lifespace-console-production/deploy",
  "LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET",
  "https://auth.aisr.online",
  "https://core.aisr.online",
  "prepare-production-console-access.mjs",
  "resolve-production-console-admin.mjs",
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
  ["staging service target", /auth-staging\.aisr\.online|core-staging\.aisr\.online|lifespace-console-staging|CLOUDFLARE_ENV=staging/iu],
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

const requiredAccessBootstrap = [
  'PRODUCTION_ACCESS_DOMAIN = "lifespace.aisr.online"',
  'STAGING_ACCESS_DOMAIN = "lifespace-staging.aisr.online"',
  'type: "self_hosted"',
  'policy.decision !== "allow"',
  '"everyone"',
  '"any_valid_service_token"',
  '"service_token"',
  'explicit email include rule',
  'method: "POST"',
  'LIFESPACE_PRODUCTION_CONSOLE_ACCESS_AUD',
];
for (const token of requiredAccessBootstrap) {
  if (!accessBootstrap.includes(token)) throw new Error(`${accessBootstrapPath} must include ${token}`);
}
const forbiddenAccessBootstrap = [
  ["staging LifeSpace service access", /auth-staging\.aisr\.online|core-staging\.aisr\.online/iu],
  ["bootstrap secret", /LIFESPACE_(?:STAGING|PRODUCTION)_BOOTSTRAP_SECRET/iu],
  ["business data mutation", /\/api\/v1\/spaces\//iu],
];
for (const [label, pattern] of forbiddenAccessBootstrap) {
  if (pattern.test(accessBootstrap)) throw new Error(`${accessBootstrapPath} violates Access-bootstrap isolation: ${label}`);
}

const requiredAdminBootstrap = [
  'assertProductionServiceUrl(identityBase, "identity")',
  'PRODUCTION_IDENTITY_DATABASE_NAME = "lifespace-identity"',
  '"/d1/database?per_page=1000"',
  '/d1/database/${encodeURIComponent(databaseId)}/query',
  'INNER JOIN access_principals ap ON ap.user_id = u.id',
  "u.status = 'active' AND ap.status = 'active'",
  '"LIMIT 2"',
  'selectUniqueAccessBackedUserId',
  'resolveUniqueDatabaseId',
  '/bootstrap/v1/platform-administrators',
  'method: "PUT"',
  'LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID',
  'databaseResolvedByName: true',
  'emailUsedAsAuthority: false',
  'accessSubjectUsedAsAuthority: false',
];
for (const token of requiredAdminBootstrap) {
  if (!adminBootstrap.includes(token)) throw new Error(`${adminBootstrapPath} must include ${token}`);
}
const forbiddenAdminBootstrap = [
  ["staging environment/service", /auth-staging\.aisr\.online|lifespace-identity-staging/iu],
  ["placeholder production D1", /00000000-0000-0000-0000-000000000013/iu],
  ["business/Core data", /apps\/core|core\.aisr\.online|\/api\/v1\/spaces\//iu],
  ["application-owned external identity", /external_identities/iu],
  ["email matching expression", /email_snapshot\s*(?:=|LIKE)|display_name\s*(?:=|LIKE)/iu],
];
for (const [label, pattern] of forbiddenAdminBootstrap) {
  if (pattern.test(adminBootstrap)) throw new Error(`${adminBootstrapPath} violates platform-admin bootstrap isolation: ${label}`);
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
  productionAccessBootstrapOwnerOnly: true,
  stagingAccessUsedAsConfigurationTemplateOnly: true,
  productionAdminBootstrapUsesVerifiedAccessMappingOnly: true,
  productionAdminBootstrapResolvesRealD1ByName: true,
  productionAdminBootstrapRequiresUniqueCandidate: true,
  productionAdminBootstrapEmailAuthorityAbsent: true,
  rolloutStatusObservable: true,
  coreIdentityMigrationAbsent: true,
  coreIdentityDeploymentAbsent: true,
  businessDataMutationAbsent: true,
  temporaryPushRestrictedToExactMainSha: true,
  productionBindingsIsolated: true,
}));
