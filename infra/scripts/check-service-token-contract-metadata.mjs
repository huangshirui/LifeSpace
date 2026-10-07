import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const requireText = (relativePath, expected) => {
  const source = read(relativePath);
  if (!source.includes(expected)) throw new Error(`${relativePath} is missing canonical Service API Token metadata: ${expected}`);
};
const rejectText = (relativePath, forbidden) => {
  const source = read(relativePath);
  if (source.includes(forbidden)) throw new Error(`${relativePath} still advertises legacy-only Service API Token metadata: ${forbidden}`);
};

const canonical = "lsp_svc_* Service API Token (legacy lsp_pat_* accepted)";
for (const relativePath of [
  "apps/core/openapi.yaml",
  "apps/core/integration-eventing.openapi.yaml",
  "apps/core/model-control-plane.openapi.yaml",
  "apps/core/src/model-contract.ts",
]) {
  requireText(relativePath, canonical);
  rejectText(relativePath, "JWT or lsp_pat_");
}
requireText("apps/core/platform-admin.openapi.yaml", `service JWT or ${canonical}`);
rejectText("apps/core/platform-admin.openapi.yaml", "service JWT or lsp_pat_");
requireText("apps/identity/openapi.yaml", "Create a canonical opaque lsp_svc_* Service API Token");
rejectText("apps/identity/openapi.yaml", "Create an opaque lsp_pat_* Service API Token");
requireText("apps/core/src/auth.ts", 'SERVICE_TOKEN_PREFIXES = ["lsp_svc_", "lsp_pat_"] as const');
requireText("infra/scripts/verify-staging-apac-performance.mjs", "opaque lsp_svc_* Service API Token");
requireText(".github/workflows/production-deploy.yml", "lsp_svc_*");
rejectText(".github/workflows/production-deploy.yml", "lsp_pat_*");

console.log("Canonical Service API Token contract metadata check passed");
