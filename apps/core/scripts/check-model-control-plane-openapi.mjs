import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../model-control-plane.openapi.yaml", import.meta.url), "utf8"));
if (document.openapi !== "3.1.0" || document.info?.version !== "0.1.0" || !document.info?.title?.includes("Model Control Plane")) {
  throw new Error("Core Model Control Plane OpenAPI metadata is invalid");
}
const required = ["/api/v1/model-admin/models","/api/v1/model-admin/models/validate","/api/v1/model-admin/models/{modelKey}","/api/v1/model-admin/models/{modelKey}/retire","/api/v1/model-admin/contracts/active","/api/v1/model-admin/contracts/{contractId}","/api/v1/model-admin/ai/proposals","/api/v1/model-admin/ai/proposals/{proposalId}","/api/v1/model-admin/ai/proposals/{proposalId}/publish","/api/v1/model-admin/ai/proposals/{proposalId}/discard"];
for (const path of required) if (!document.paths?.[path]) throw new Error(`Model Control Plane missing ${path}`);
for (const path of Object.keys(document.paths ?? {})) {
  if (!path.startsWith("/api/v1/model-admin/")) throw new Error(`Non-model-control route leaked into Model Control Plane: ${path}`);
}
const adminModels = document.paths?.["/api/v1/model-admin/models"];
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

const aiList = document.paths?.["/api/v1/model-admin/ai/proposals"]?.get;
const aiCreate = document.paths?.["/api/v1/model-admin/ai/proposals"]?.post;
const aiPublish = document.paths?.["/api/v1/model-admin/ai/proposals/{proposalId}/publish"]?.post;
if (!aiList || !aiCreate || !aiPublish) throw new Error("AI Model Proposal lifecycle is incomplete in Model Control Plane contract");
if (!String(document.info?.description ?? "").includes("service-principal-only") || !String(document.info?.description ?? "").includes("models:manage")) {
  throw new Error("Model Control Plane must preserve service-only models:manage authority");
}
if (!String(document.info?.description ?? "").includes("not become a second semantic source")) {
  throw new Error("Model Control Plane must preserve Model Definition semantic ownership");
}
if (document.components?.securitySchemes?.platformAdminActor) throw new Error("Human actor proof must remain a Platform Admin overlay, not Model Control Plane baseline authority");
for (const name of ["ModelDefinition","PublishModelRequest","PublishedModelResponse","ModelContractResponse","AiModelProposalResponse","PublishAiModelProposalResponse"]) {
  if (!schemas[name]) throw new Error(`Model Control Plane missing schema ${name}`);
}
if (!String(schemas.ModelDefinition?.description ?? "").includes("Closed declarative Model Definition v1")) {
  throw new Error("Model Control Plane must reuse the canonical bounded Model Definition wire schema");
}
console.log("Core Model Control Plane OpenAPI contract sanity check passed");
