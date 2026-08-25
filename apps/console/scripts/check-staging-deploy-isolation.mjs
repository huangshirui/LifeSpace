import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../../.github/workflows/lifespace-console-staging-deploy.yml", import.meta.url);
const workflowPath = fileURLToPath(workflowUrl);
const source = readFileSync(workflowUrl, "utf8");

const required = [
  "workflow_dispatch:",
  "pnpm --filter @lifespace/console check",
  "https://auth-staging.aisr.online/api/v1/status",
  "https://core-staging.aisr.online/api/v1/status",
  "CLOUDFLARE_ENV=staging pnpm exec vite build",
  "pnpm exec wrangler deploy",
  "lifespace-staging.aisr.online",
];

for (const token of required) {
  if (!source.includes(token)) throw new Error(`${workflowPath} must include ${token}`);
}

const forbidden = [
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

for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) throw new Error(`${workflowPath} violates Console-only staging isolation: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  workflow: ".github/workflows/lifespace-console-staging-deploy.yml",
  manualOnly: true,
  coreIdentityMutationAbsent: true,
  bootstrapAuthorityAbsent: true,
  productionTargetAbsent: true,
}));
