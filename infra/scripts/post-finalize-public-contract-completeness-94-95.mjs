import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const path = resolve(root, "apps/core/scripts/check-openapi.mjs");
let text = await readFile(path, "utf8");
const stale = `const adminModels = document.paths?.["/api/v1/model-admin/models"];
if (!adminModels?.get?.description?.includes("Service-principal-only") || !adminModels?.post?.description?.includes("Service-principal-only")) {
  throw new Error("Model Admin must be documented as service-principal-only");
}
if (!document.paths?.["/api/v1/model-admin/contracts/active"]?.get) {
  throw new Error("Active Model Contract Revision read surface is missing");
}
if (schemas.ModelCompatibility?.enum?.join(",") !== "initial,compatible,breaking") {
  throw new Error("Model compatibility values drifted");
}
if (schemas.ModelContract?.properties?.id?.pattern !== "^mct_[a-f0-9]{64}$") {
  throw new Error("Model Contract revisions must be content-addressed mct_<sha256>");
}

`;
if (!text.includes(stale)) throw new Error("stale Kernel Model Admin checker block was not found");
text = text.replace(stale, "");
text = text.replace(
  'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.29.0"',
  'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.30.0"',
);
await writeFile(path, text, "utf8");

const controlPath = resolve(root, "apps/core/scripts/check-model-control-plane-openapi.mjs");
let control = await readFile(controlPath, "utf8");
const anchor = 'const aiList = document.paths?.["/api/v1/model-admin/ai/proposals"]?.get;';
if (!control.includes(anchor)) throw new Error("Model Control Plane checker insertion anchor missing");
control = control.replace(anchor, `const adminModels = document.paths?.["/api/v1/model-admin/models"];
if (!adminModels?.get?.description?.includes("Service-principal-only") || !adminModels?.post?.description?.includes("Service-principal-only")) {
  throw new Error("Model Registry control must remain service-principal-only");
}
if (!document.paths?.["/api/v1/model-admin/contracts/active"]?.get) {
  throw new Error("Active Model Contract Revision read surface is missing from Model Control Plane");
}
const schemas = document.components?.schemas ?? {};
if (schemas.ModelCompatibility?.enum?.join(",") !== "initial,compatible,breaking") {
  throw new Error("Model compatibility values drifted");
}
if (schemas.ModelContract?.properties?.id?.pattern !== "^mct_[a-f0-9]{64}$") {
  throw new Error("Model Contract revisions must remain content-addressed mct_<sha256>");
}

${anchor}`);
control = control.replace('const schemas = document.components?.schemas ?? {};\nfor (const name of', 'for (const name of');
await writeFile(controlPath, control, "utf8");
