import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const productionUrl = new URL("../../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url);
const stagingProvisionUrl = new URL("../../../.github/workflows/lifespace-console-staging-provision.yml", import.meta.url);

for (const url of [productionUrl, stagingProvisionUrl]) {
  const path = fileURLToPath(url);
  const source = readFileSync(url, "utf8");
  if (!source.includes("startsWith('lsp_svc_')")) {
    throw new Error(`${path} must validate newly provisioned Console Core executors as canonical lsp_svc_* tokens`);
  }
  if (source.includes("startsWith('lsp_pat_')")) {
    throw new Error(`${path} must not require legacy lsp_pat_* for newly provisioned Console Core executors`);
  }
}

console.log(JSON.stringify({
  ok: true,
  canonicalConsoleCoreExecutorPrefix: "lsp_svc_*",
  legacyProvisioningRequirementAbsent: true,
}));
