import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const write = (path, value) => writeFile(resolve(root, path), value, "utf8");

function fail(message) {
  throw new Error(`[finalize-94-95] ${message}`);
}

function requireReplace(text, search, replacement, label) {
  if (!text.includes(search)) fail(`missing replacement anchor: ${label}`);
  return text.replace(search, replacement);
}

function operations(document) {
  const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
  const result = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of Object.keys(item)) {
      if (methods.has(method.toLowerCase())) result.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...new Set(result)].sort();
}

function operationDigest(document) {
  return `sha256:${createHash("sha256").update(operations(document).join("\n")).digest("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectComponents(source, seed, customSchemas = {}) {
  const result = {
    securitySchemes: { bearerAuth: clone(source.securitySchemes.bearerAuth) },
    parameters: {},
    responses: {},
    schemas: clone(customSchemas),
  };
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const match = child.match(/^#\/components\/([^/]+)\/(.+)$/u);
        if (match) {
          const [, kind, name] = match;
          const token = `${kind}/${name}`;
          if (!seen.has(token)) {
            seen.add(token);
            if (kind === "schemas" && Object.hasOwn(customSchemas, name)) {
              visit(customSchemas[name]);
            } else {
              const sourceValue = source?.[kind]?.[name];
              if (!sourceValue) fail(`missing source component ${token}`);
              if (!result[kind]) result[kind] = {};
              result[kind][name] = clone(sourceValue);
              visit(sourceValue);
            }
          }
        }
      } else {
        visit(child);
      }
    }
  };
  visit(seed);
  for (const schema of Object.values(customSchemas)) visit(schema);
  return result;
}

const kernelPath = "apps/core/openapi.yaml";
const kernel = JSON.parse(await read(kernelPath));
if (kernel.info?.version !== "0.29.0") fail(`expected Kernel 0.29.0, found ${kernel.info?.version}`);

const modelPathNames = [
  "/api/v1/model-admin/models",
  "/api/v1/model-admin/models/validate",
  "/api/v1/model-admin/models/{modelKey}",
  "/api/v1/model-admin/models/{modelKey}/retire",
  "/api/v1/model-admin/contracts/active",
  "/api/v1/model-admin/contracts/{contractId}",
];
const modelPaths = {};
for (const path of modelPathNames) {
  if (!kernel.paths?.[path]) fail(`Kernel missing expected Model Admin path ${path}`);
  modelPaths[path] = clone(kernel.paths[path]);
  delete kernel.paths[path];
}

const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
const jsonResponse = (schemaRef, description = "Success") => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
});

const customSchemas = {
  CreateAiModelProposalRequest: {
    type: "object",
    additionalProperties: false,
    required: ["instruction"],
    properties: {
      instruction: { type: "string", minLength: 1, maxLength: 5000 },
      targetModelKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" },
    },
  },
  AiModelProposalStatus: { type: "string", enum: ["draft", "proposed", "published", "discarded"] },
  AiModelProposal: {
    type: "object",
    additionalProperties: false,
    required: [
      "id", "status", "modelKey", "baseModelVersion", "instruction", "definition", "validation",
      "schemaHash", "diff", "recommendedCompatibility", "publicationInProgress", "ai",
      "publishedModelId", "createdBy", "createdAt", "updatedAt", "publishedAt", "discardedAt",
    ],
    properties: {
      id: { type: "string", pattern: "^mdr_ai_" },
      status: { $ref: "#/components/schemas/AiModelProposalStatus" },
      modelKey: { type: "string" },
      baseModelVersion: { type: ["integer", "null"], minimum: 1 },
      instruction: { type: ["string", "null"] },
      definition: {
        type: "object",
        additionalProperties: true,
        description: "Proposed Model Definition payload. Detailed DSL semantics remain governed by the normative Model Definition specification and Core validator; this control-plane contract is not a second DSL source.",
      },
      validation: { type: "object", additionalProperties: true },
      schemaHash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
      diff: { type: ["object", "null"], additionalProperties: true },
      recommendedCompatibility: {
        anyOf: [{ $ref: "#/components/schemas/ModelCompatibility" }, { type: "null" }],
      },
      publicationInProgress: { type: "boolean" },
      ai: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "warnings"],
        properties: {
          summary: { type: ["string", "null"] },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      publishedModelId: { type: ["string", "null"] },
      createdBy: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id", "displayName"],
        properties: {
          type: { const: "service" },
          id: { type: "string", minLength: 1 },
          displayName: { type: "string", minLength: 1 },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      publishedAt: { type: ["string", "null"], format: "date-time" },
      discardedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  AiModelProposalResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data: { $ref: "#/components/schemas/AiModelProposal" } },
  },
  AiModelProposalListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: { $ref: "#/components/schemas/AiModelProposal" } },
    },
  },
  PublishAiModelProposalRequest: {
    type: "object",
    additionalProperties: false,
    required: ["compatibility"],
    properties: { compatibility: { $ref: "#/components/schemas/ModelCompatibility" } },
  },
  PublishAiModelProposalResult: {
    type: "object",
    additionalProperties: false,
    required: ["proposal", "publishedModel"],
    properties: {
      proposal: { $ref: "#/components/schemas/AiModelProposal" },
      publishedModel: { $ref: "#/components/schemas/PublishedModel" },
    },
  },
  PublishAiModelProposalResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data: { $ref: "#/components/schemas/PublishAiModelProposalResult" } },
  },
};

const proposalParameter = {
  name: "proposalId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^mdr_ai_[A-Za-z0-9_-]+$" },
};
const aiPaths = {
  "/api/v1/model-admin/ai/proposals": {
    get: {
      tags: ["AI Model Proposals"],
      operationId: "listAiModelProposals",
      description: "Service-principal-only AI-assisted Model Definition proposal list. Requires models:manage. Proposal generation is optional intelligence; Model Definition validation/publication remains authoritative in Core.",
      parameters: [{ name: "status", in: "query", schema: { $ref: "#/components/schemas/AiModelProposalStatus" } }],
      responses: {
        200: jsonResponse("AiModelProposalListResponse"),
        400: responseRef("InvalidRequest"), 401: responseRef("Unauthorized"), 403: responseRef("Forbidden"),
      },
    },
    post: {
      tags: ["AI Model Proposals"],
      operationId: "createAiModelProposal",
      description: "Service-principal-only optional AI proposal generation. Requires models:manage and is rate-limited. The generated definition is validated by the same canonical Model Definition validator before it can become proposed/publishable.",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateAiModelProposalRequest" } } } },
      responses: {
        201: jsonResponse("AiModelProposalResponse", "Proposal created"),
        400: responseRef("InvalidRequest"), 401: responseRef("Unauthorized"), 403: responseRef("Forbidden"),
        404: responseRef("NotFound"), 422: responseRef("ValidationError"),
        429: { description: "AI model proposal rate limit reached", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        502: { description: "AI provider failed or returned an invalid response", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        503: { description: "AI provider is not configured", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        504: { description: "AI provider timed out", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      },
    },
  },
  "/api/v1/model-admin/ai/proposals/{proposalId}": {
    parameters: [proposalParameter],
    get: {
      tags: ["AI Model Proposals"],
      operationId: "getAiModelProposal",
      description: "Service-principal-only read of one AI Model Definition proposal. Requires models:manage.",
      responses: {
        200: jsonResponse("AiModelProposalResponse"),
        401: responseRef("Unauthorized"), 403: responseRef("Forbidden"), 404: responseRef("NotFound"),
      },
    },
  },
  "/api/v1/model-admin/ai/proposals/{proposalId}/publish": {
    parameters: [proposalParameter],
    post: {
      tags: ["AI Model Proposals"],
      operationId: "publishAiModelProposal",
      description: "Service-principal-only publication of a validated proposal through the canonical Model Registry publication path. Requires models:manage; compatibility under-classification remains rejected by Core.",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PublishAiModelProposalRequest" } } } },
      responses: {
        201: jsonResponse("PublishAiModelProposalResponse", "Proposal published through the canonical Model Registry"),
        400: responseRef("InvalidRequest"), 401: responseRef("Unauthorized"), 403: responseRef("Forbidden"),
        404: responseRef("NotFound"), 409: responseRef("Conflict"),
      },
    },
  },
  "/api/v1/model-admin/ai/proposals/{proposalId}/discard": {
    parameters: [proposalParameter],
    post: {
      tags: ["AI Model Proposals"],
      operationId: "discardAiModelProposal",
      description: "Service-principal-only discard of a non-published AI Model Definition proposal. Requires models:manage. The request body must be an empty JSON object.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
      responses: {
        200: jsonResponse("AiModelProposalResponse", "Proposal discarded"),
        400: responseRef("InvalidRequest"), 401: responseRef("Unauthorized"), 403: responseRef("Forbidden"),
        404: responseRef("NotFound"), 409: responseRef("Conflict"),
      },
    },
  },
};

const controlPaths = { ...modelPaths, ...aiPaths };
const controlComponents = collectComponents(kernel.components, { paths: controlPaths }, customSchemas);
const modelControl = {
  openapi: "3.1.0",
  info: {
    title: "LifeSpace Core Model Control Plane API",
    version: "0.1.0",
    description: "Canonical independently versioned control-plane contract for Model Registry validation/publication/retirement, immutable Model Contract evidence, and the optional AI-assisted proposal lifecycle. Every operation is service-principal-only and requires models:manage. Model Definition DSL semantics remain owned by the normative specification and Core validator; this contract defines control-plane wire representation and does not become a second semantic source. LifeSpace Console may apply a separate Platform Admin human-actor/audit profile over selected mutations without changing service-automation authority.",
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Model Registry" },
    { name: "Model Contract Revisions" },
    { name: "AI Model Proposals" },
  ],
  paths: controlPaths,
  components: controlComponents,
};
for (const [path, item] of Object.entries(modelControl.paths)) {
  for (const operation of Object.values(item)) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || !operation.operationId) continue;
    if (operation.tags?.includes("Model Admin")) {
      if (path.includes("/contracts/")) operation.tags = ["Model Contract Revisions"];
      else operation.tags = ["Model Registry"];
    }
  }
}

const oldChangePath = "/api/v1/spaces/{spaceId}/changes/{recordId}";
const oldChange = kernel.paths?.[oldChangePath];
if (!oldChange?.get) fail("Kernel missing legacy Change History route");
oldChange.get.deprecated = true;
oldChange.get.description = "Deprecated Kernel 0.29 compatibility alias. Returns at most the latest 100 governed Change entries for the path recordId without pagination. New consumers must use GET /api/v1/spaces/{spaceId}/changes?recordId=... with explicit limit/cursor collection semantics. Read authority is still rechecked against the record's current published model.";

kernel.paths["/api/v1/spaces/{spaceId}/changes"] = {
  parameters: [{ $ref: "#/components/parameters/SpaceId" }],
  get: {
    tags: ["Change History"],
    operationId: "listRecordChangeHistory",
    description: "Canonical record-scoped Change History collection. Returns append-only governed Change evidence for exactly one ordinary record selected by the required recordId query parameter. Results are ordered newest-first by version/time/id and use opaque keyset cursor pagination. Read authority is rechecked against the record's current published model; delegated Agent callers remain bounded by their current Delegation.",
    parameters: [
      { name: "recordId", in: "query", required: true, schema: { type: "string", pattern: "^rec_[A-Za-z0-9_-]+$", maxLength: 200 } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
    ],
    responses: {
      200: jsonResponse("ResourceChangePageResponse"),
      400: responseRef("InvalidRequest"), 401: responseRef("Unauthorized"), 403: responseRef("Forbidden"), 404: responseRef("NotFound"),
    },
  },
};
kernel.components.schemas.ResourceChangePageResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items", "nextCursor"],
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/ResourceChange" } },
        nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
};

kernel.info.version = "0.30.0";
kernel.info.description = String(kernel.info.description)
  .replace(", model administration, assets", ", assets")
  .concat(" Model Registry governance is owned by the separately versioned LifeSpace Core Model Control Plane contract; it is not part of the application-facing Kernel contract.");
kernel.tags = (kernel.tags ?? []).filter((tag) => tag?.name !== "Model Admin");
kernel.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.30.0";

for (const name of [
  "ModelCompatibility", "ModelDefinition", "PublishedModel", "PublishedModelResponse", "PublishedModelListResponse",
  "ValidateModelRequest", "PublishModelRequest", "ModelValidationIssue", "ModelValidationResponse",
  "ModelContractManifestEntry", "ModelContract", "ModelContractResponse", "ActiveModelContractResponse",
]) {
  delete kernel.components.schemas[name];
}
delete kernel.components.parameters.ContractId;
const kernelSerialized = JSON.stringify(kernel);
if (kernelSerialized.includes("/api/v1/model-admin")) fail("Model Admin path remains in Kernel contract");
if (kernelSerialized.includes("#/components/schemas/PublishModelRequest")) fail("Model Admin schema reference remains in Kernel contract");
await write(kernelPath, kernelSerialized);
await write("apps/core/model-control-plane.openapi.yaml", `${JSON.stringify(modelControl, null, 2)}\n`);

let appTs = await read("apps/core/src/app.ts");
appTs = requireReplace(appTs, 'contractVersion: "0.29.0"', 'contractVersion: "0.30.0"', "Core status contract version");
await write("apps/core/src/app.ts", appTs);

const packageJson = JSON.parse(await read("apps/core/package.json"));
packageJson.version = "0.30.0";
packageJson.scripts.contract = "node scripts/check-openapi.mjs && node scripts/check-model-control-plane-openapi.mjs && node scripts/check-kernel-route-namespace.mjs && node scripts/check-platform-admin-openapi.mjs";
await write("apps/core/package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

let platformAdmin = await read("apps/core/platform-admin.openapi.yaml");
platformAdmin = requireReplace(platformAdmin, "version: 0.1.0", "version: 0.2.0", "Platform Admin version");
platformAdmin = requireReplace(
  platformAdmin,
  "platform automation. This contract is separate from the downstream Core Kernel Contract:",
  "platform automation. This contract is separate from both the downstream Core Kernel Contract and the service-automation Model Control Plane Contract:",
  "Platform Admin description",
);
platformAdmin = platformAdmin.replaceAll("./openapi.yaml#/components/schemas/PublishModelRequest", "./model-control-plane.openapi.yaml#/components/schemas/PublishModelRequest");
platformAdmin = platformAdmin.replaceAll("./openapi.yaml#/components/schemas/PublishedModelResponse", "./model-control-plane.openapi.yaml#/components/schemas/PublishedModelResponse");
await write("apps/core/platform-admin.openapi.yaml", platformAdmin);

let checkKernel = await read("apps/core/scripts/check-openapi.mjs");
checkKernel = requireReplace(checkKernel, 'document.info?.version !== "0.29.0"', 'document.info?.version !== "0.30.0"', "Kernel checker version");
checkKernel = requireReplace(
  checkKernel,
  'if (!document.info?.description?.includes("Model Contract Revision")) {\n  throw new Error("Kernel OpenAPI must explain the separate immutable Model Contract surface");\n}\n',
  'if (!document.info?.description?.includes("Model Contract Revision")) {\n  throw new Error("Kernel OpenAPI must explain the separate immutable Model Contract surface");\n}\nif (!document.info?.description?.includes("Model Control Plane")) {\n  throw new Error("Kernel OpenAPI must document the separate Model Control Plane contract");\n}\n',
  "Kernel separate model control check",
);
checkKernel = requireReplace(
  checkKernel,
  '  "/api/v1/spaces/{spaceId}/changes/{recordId}",',
  '  "/api/v1/spaces/{spaceId}/changes",\n  "/api/v1/spaces/{spaceId}/changes/{recordId}",',
  "Kernel Change History required paths",
);
for (const line of [
  '  "/api/v1/model-admin/models",\n',
  '  "/api/v1/model-admin/models/validate",\n',
  '  "/api/v1/model-admin/models/{modelKey}",\n',
  '  "/api/v1/model-admin/models/{modelKey}/retire",\n',
  '  "/api/v1/model-admin/contracts/active",\n',
  '  "/api/v1/model-admin/contracts/{contractId}",\n',
]) checkKernel = requireReplace(checkKernel, line, "", `remove Kernel checker ${line.trim()}`);
checkKernel = requireReplace(
  checkKernel,
  'for (const path of requiredPaths) {\n  if (!document.paths?.[path]) throw new Error(`Core Kernel OpenAPI missing ${path}`);\n}\n',
  'for (const path of requiredPaths) {\n  if (!document.paths?.[path]) throw new Error(`Core Kernel OpenAPI missing ${path}`);\n}\nfor (const path of Object.keys(document.paths ?? {})) {\n  if (path.startsWith("/api/v1/model-admin")) throw new Error(`Model Control Plane route leaked into Kernel OpenAPI: ${path}`);\n}\nconst canonicalChanges = document.paths?.["/api/v1/spaces/{spaceId}/changes"]?.get;\nconst legacyChanges = document.paths?.["/api/v1/spaces/{spaceId}/changes/{recordId}"]?.get;\nconst changeParams = new Map((canonicalChanges?.parameters ?? []).map((entry) => [entry.name, entry]));\nif (canonicalChanges?.operationId !== "listRecordChangeHistory"\n    || changeParams.get("recordId")?.required !== true\n    || changeParams.get("limit")?.schema?.default !== 50\n    || changeParams.get("limit")?.schema?.maximum !== 100\n    || !changeParams.has("cursor")\n    || canonicalChanges?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ResourceChangePageResponse") {\n  throw new Error("Canonical Change History collection semantics drifted");\n}\nif (legacyChanges?.deprecated !== true\n    || legacyChanges?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ResourceChangeListResponse") {\n  throw new Error("Legacy Change History alias must remain explicitly deprecated and wire-compatible");\n}\n',
  "Kernel Change History contract checks",
);
await write("apps/core/scripts/check-openapi.mjs", checkKernel);

const modelControlCheck = `import fs from "node:fs";\nimport YAML from "yaml";\n\nconst document = YAML.parse(fs.readFileSync(new URL("../model-control-plane.openapi.yaml", import.meta.url), "utf8"));\nif (document.openapi !== "3.1.0" || document.info?.version !== "0.1.0" || !document.info?.title?.includes("Model Control Plane")) {\n  throw new Error("Core Model Control Plane OpenAPI metadata is invalid");\n}\nconst required = ${JSON.stringify([...modelPathNames, ...Object.keys(aiPaths)])};\nfor (const path of required) if (!document.paths?.[path]) throw new Error(\`Model Control Plane missing \${path}\`);\nfor (const path of Object.keys(document.paths ?? {})) {\n  if (!path.startsWith("/api/v1/model-admin/")) throw new Error(\`Non-model-control route leaked into Model Control Plane: \${path}\`);\n}\nconst aiList = document.paths?.["/api/v1/model-admin/ai/proposals"]?.get;\nconst aiCreate = document.paths?.["/api/v1/model-admin/ai/proposals"]?.post;\nconst aiPublish = document.paths?.["/api/v1/model-admin/ai/proposals/{proposalId}/publish"]?.post;\nif (!aiList || !aiCreate || !aiPublish) throw new Error("AI Model Proposal lifecycle is incomplete in Model Control Plane contract");\nif (!String(document.info?.description ?? "").includes("service-principal-only") || !String(document.info?.description ?? "").includes("models:manage")) {\n  throw new Error("Model Control Plane must preserve service-only models:manage authority");\n}\nif (!String(document.info?.description ?? "").includes("not become a second semantic source")) {\n  throw new Error("Model Control Plane must preserve Model Definition semantic ownership");\n}\nif (document.components?.securitySchemes?.platformAdminActor) throw new Error("Human actor proof must remain a Platform Admin overlay, not Model Control Plane baseline authority");\nconst schemas = document.components?.schemas ?? {};\nfor (const name of ["ModelDefinition","PublishModelRequest","PublishedModelResponse","ModelContractResponse","AiModelProposalResponse","PublishAiModelProposalResponse"]) {\n  if (!schemas[name]) throw new Error(\`Model Control Plane missing schema \${name}\`);\n}\nif (!String(schemas.ModelDefinition?.description ?? "").includes("Closed declarative Model Definition v1")) {\n  throw new Error("Model Control Plane must reuse the canonical bounded Model Definition wire schema");\n}\nconsole.log("Core Model Control Plane OpenAPI contract sanity check passed");\n`;
await write("apps/core/scripts/check-model-control-plane-openapi.mjs", modelControlCheck);

let checkPlatform = await read("apps/core/scripts/check-platform-admin-openapi.mjs");
checkPlatform = requireReplace(checkPlatform, 'document.info?.version !== "0.1.0"', 'document.info?.version !== "0.2.0"', "Platform checker version");
checkPlatform = requireReplace(
  checkPlatform,
  'const auditResult = document.components?.schemas?.PlatformAuditEntry?.properties?.result?.enum ?? [];',
  'const publishSchemaRef = document.paths?.["/api/v1/model-admin/models"]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref;\nif (publishSchemaRef !== "./model-control-plane.openapi.yaml#/components/schemas/PublishModelRequest") {\n  throw new Error("Platform Admin Console publish profile must reuse the Model Control Plane request schema");\n}\nconst auditResult = document.components?.schemas?.PlatformAuditEntry?.properties?.result?.enum ?? [];',
  "Platform checker model control ref",
);
await write("apps/core/scripts/check-platform-admin-openapi.mjs", checkPlatform);

let rootAgents = await read("AGENTS.md");
rootAgents = requireReplace(
  rootAgents,
  "- Core business-facing Kernel API: `apps/core/openapi.yaml`\n- Core privileged Platform Admin API: `apps/core/platform-admin.openapi.yaml`",
  "- Core business-facing Kernel API: `apps/core/openapi.yaml`\n- Core Model Registry / Model Contract governance API: `apps/core/model-control-plane.openapi.yaml`\n- Core privileged Platform Admin API: `apps/core/platform-admin.openapi.yaml`",
  "root AGENTS sources",
);
rootAgents = requireReplace(
  rootAgents,
  "Core Kernel:\n  apps/core/openapi.yaml\n\nCore Platform Admin:\n  apps/core/platform-admin.openapi.yaml",
  "Core Kernel:\n  apps/core/openapi.yaml\n\nCore Model Control Plane:\n  apps/core/model-control-plane.openapi.yaml\n\nCore Platform Admin:\n  apps/core/platform-admin.openapi.yaml",
  "root AGENTS contract workflow",
);
await write("AGENTS.md", rootAgents);

let coreAgents = await read("apps/core/AGENTS.md");
coreAgents = requireReplace(coreAgents, "current Kernel version: 0.29.0", "current Kernel version: 0.30.0", "Core AGENTS Kernel version");
coreAgents = requireReplace(
  coreAgents,
  "Privileged LifeSpace Console control-plane contract:\n\n```text\napps/core/platform-admin.openapi.yaml\ncurrent Platform Admin version: 0.1.0\n```",
  "Model Registry / Model Contract governance contract:\n\n```text\napps/core/model-control-plane.openapi.yaml\ncurrent Model Control Plane version: 0.1.0\n```\n\nPrivileged LifeSpace Console control-plane contract:\n\n```text\napps/core/platform-admin.openapi.yaml\ncurrent Platform Admin version: 0.2.0\n```",
  "Core AGENTS contract layers",
);
await write("apps/core/AGENTS.md", coreAgents);

let architecture = await read("docs/architecture.md");
architecture = requireReplace(architecture, "current Kernel contract: 0.29.0", "current Kernel contract: 0.30.0", "architecture Kernel version");
architecture = requireReplace(
  architecture,
  "Platform Admin Control-Plane Contract\n  apps/core/platform-admin.openapi.yaml\n  independent companion contract: 0.1.0\n\nModel Contract Revision",
  "Model Control Plane Contract\n  apps/core/model-control-plane.openapi.yaml\n  independent governance contract: 0.1.0\n\nPlatform Admin Control-Plane Contract\n  apps/core/platform-admin.openapi.yaml\n  independent companion contract: 0.2.0\n\nModel Contract Revision",
  "architecture Core contract layers",
);
architecture = requireReplace(
  architecture,
  "The separate Platform Admin contract prevents adding Console-only privileged APIs",
  "The separate Model Control Plane prevents Model Registry governance and optional AI proposal syntax from being pinned by ordinary Runtime consumers. The separate Platform Admin contract prevents adding Console-only privileged APIs",
  "architecture control-plane explanation",
);
await write("docs/architecture.md", architecture);

let contracts = await read("docs/contracts.md");
contracts = contracts.replace("Core has three contract layers:", "Core has four contract layers:");
contracts = requireReplace(
  contracts,
  "1. **Kernel Contract** — explicit, code-owned APIs such as Space, Membership, Data Grant, Runtime Discovery, Webhook Endpoint/Event Subscription, Registry-driven Creation Draft orchestration and service-only model administration. The checked-in contract is `apps/core/openapi.yaml` and is versioned independently from ordinary models.\n2. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged control-plane profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Its initial version is `0.1.0`.\n3. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.",
  "1. **Kernel Contract** — explicit application/runtime APIs such as Space, Membership, Data Grant, Runtime Discovery, Webhook Endpoint/Event Subscription, Registry-driven Creation Draft orchestration and governed Change History. The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.30.0` no longer owns Model Registry governance operations.\n2. **Model Control Plane Contract** — `apps/core/model-control-plane.openapi.yaml`, the independently versioned service-automation contract for Model Definition validation/publication/retirement, immutable Model Contract evidence and the optional AI-assisted proposal lifecycle. Its initial version is `0.1.0`; every operation remains service-principal-only with `models:manage`.\n3. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged Console companion profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Version `0.2.0` reuses Model Control Plane publish/retire wire schemas rather than treating Kernel as their owner.\n4. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.",
  "contracts Core layers",
);
contracts = contracts.replace("As of Core Kernel `0.29.0`", "As of Core Kernel `0.30.0`");
contracts = requireReplace(
  contracts,
  "Kernel `0.29.0` adds model-owned canonical ordinary-record `referenceLabel` semantics, exposes them in Runtime Discovery and progressive static detail, and enables `record` / `record_list` Relation Target Lookup plus Batch Reference Resolution using that same projection. Missing/blank label input falls back to stable record ID; record lookup/resolution additionally rechecks current read authority to the target Model, and all writes still recheck mutation-time authority, Policy and relation integrity.",
  "Kernel `0.29.0` adds model-owned canonical ordinary-record `referenceLabel` semantics, exposes them in Runtime Discovery and progressive static detail, and enables `record` / `record_list` Relation Target Lookup plus Batch Reference Resolution using that same projection. Missing/blank label input falls back to stable record ID; record lookup/resolution additionally rechecks current read authority to the target Model, and all writes still recheck mutation-time authority, Policy and relation integrity. Kernel `0.30.0` makes governed Change History an explicit record-scoped collection at `GET /api/v1/spaces/{spaceId}/changes?recordId=...` with bounded `limit` + opaque `cursor` pagination; the older `/changes/{recordId}` representation remains a deprecated Kernel 0.29 compatibility alias returning at most the latest 100 entries. Kernel `0.30.0` also removes `/model-admin/*` operations from Kernel ownership because those routes now belong to the separately versioned Model Control Plane `0.1.0` contract.",
  "contracts 0.30 history",
);
contracts = requireReplace(
  contracts,
  "## Model-driven generation",
  "## Model Control Plane contract\n\nModel Registry governance is a first-class control plane rather than ordinary Runtime syntax. `apps/core/model-control-plane.openapi.yaml` is the canonical wire contract for service automation that validates, publishes, retires or inspects Model Definitions/Model Contract revisions. It also explicitly contracts the optional `/api/v1/model-admin/ai/proposals*` lifecycle so staging-verified production behavior cannot exist outside contract ownership.\n\nThe Model Control Plane does **not** redefine Model Definition semantics. `docs/model-definition-spec.md` plus the Core validator/Registry remain the semantic authority; the control-plane OpenAPI defines request/response representation around that authority. AI proposal generation is optional intelligence and cannot bypass normal validation, compatibility classification or publication.\n\nNon-interactive service automation continues to authenticate as a service principal with `models:manage`. LifeSpace Console uses the same underlying Model Registry routes but adds the separate Platform Admin human actor proof and pending -> success/failure audit profile. Human actor proof is therefore an interactive governance overlay, not a new baseline requirement for CI/automation.\n\nA model-governance consumer pins `Model Control Plane 0.1.0` independently from `Kernel 0.30.0`; an ordinary application that never administers models does not need to pin or discover the Model Control Plane.\n\n## Model-driven generation",
  "contracts Model Control Plane section",
);
contracts = requireReplace(
  contracts,
  "- service-only Model Admin and immutable Model Contract reads.",
  "- governed Change History as a bounded record-scoped collection.\n\nModel Registry administration and immutable Model Contract governance are intentionally absent from Kernel 0.30.0 and live in the Model Control Plane contract instead.",
  "contracts Kernel contents",
);
await write("docs/contracts.md", contracts);

let permissions = await read("docs/permissions.md");
permissions = requireReplace(
  permissions,
  "Model-admin surfaces remain service-principal-only in the current contract.",
  "Model Registry governance surfaces remain service-principal-only with `models:manage` in the independently versioned Core Model Control Plane contract.",
  "permissions model control wording",
);
await write("docs/permissions.md", permissions);

let serviceAuth = await read("docs/service-authentication.md");
serviceAuth = requireReplace(
  serviceAuth,
  "## Model Admin automation compatibility\n\nExisting service automation with `models:manage` remains valid for non-interactive platform workflows.",
  "## Model Control Plane automation compatibility\n\nExisting service automation with `models:manage` remains valid for non-interactive platform workflows and pins the independently versioned Core Model Control Plane contract rather than the ordinary Kernel contract.",
  "service auth model control wording",
);
await write("docs/service-authentication.md", serviceAuth);

let coreReadme = await read("apps/core/README.md");
coreReadme = requireReplace(coreReadme, "current business-facing Core Kernel contract is **0.29.0**", "current business-facing Core Kernel contract is **0.30.0**", "Core README version");
const discoveryHeading = "## Current Kernel Runtime Discovery";
coreReadme = requireReplace(
  coreReadme,
  discoveryHeading,
  "## Model Control Plane\n\nModel Registry validation/publication/retirement, immutable Model Contract governance and optional AI Model Proposal APIs are declared separately in `model-control-plane.openapi.yaml` **0.1.0**. Ordinary Runtime consumers do not need to pin this contract. Service automation keeps `models:manage`; Console model mutations add the Platform Admin human-actor/audit overlay.\n\n## Current Kernel Runtime Discovery",
  "Core README Model Control Plane section",
);
await write("apps/core/README.md", coreReadme);

for (const path of ["infra/scripts/verify-staging-agent-ready.mjs", "infra/scripts/verify-staging-homemew-integration.mjs"]) {
  let text = await read(path);
  const before = text;
  text = text.replaceAll(
    "`/api/v1/spaces/${encodeURIComponent(spaceId)}/changes/${encodeURIComponent(recordId)}`",
    "`/api/v1/spaces/${encodeURIComponent(spaceId)}/changes?recordId=${encodeURIComponent(recordId)}`",
  );
  text = text.replaceAll(
    "`/api/v1/spaces/${encodeURIComponent(spaceId)}/changes/${encodeURIComponent(taskId)}`",
    "`/api/v1/spaces/${encodeURIComponent(spaceId)}/changes?recordId=${encodeURIComponent(taskId)}`",
  );
  if (text === before) fail(`did not migrate staging Change History consumer ${path}`);
  await write(path, text);
}

const baselinePath = "docs/contract-stability-baseline.json";
const baseline = JSON.parse(await read(baselinePath));
const kernelSource = baseline.contractSources.find((entry) => entry.id === "core-kernel");
if (!kernelSource) fail("contract stability baseline missing core-kernel");
kernelSource.groups = kernelSource.groups.filter((group) => group.id !== "core-model-control");
kernelSource.operationSetSha256 = operationDigest(kernel);
const existingControl = baseline.contractSources.findIndex((entry) => entry.id === "core-model-control-plane");
const controlSource = {
  id: "core-model-control-plane",
  source: "apps/core/model-control-plane.openapi.yaml",
  operationSetSha256: operationDigest(modelControl),
  groups: [
    {
      id: "core-model-registry-control",
      maturity: "candidate",
      visibility: "internal",
      operationPattern: "^(GET|POST) /api/v1/model-admin/models$|^POST /api/v1/model-admin/models/validate$|^GET /api/v1/model-admin/models/\\{modelKey\\}$|^POST /api/v1/model-admin/models/\\{modelKey\\}/retire$|^GET /api/v1/model-admin/contracts/(active|\\{contractId\\})$",
    },
    {
      id: "core-model-ai-proposals",
      maturity: "experimental",
      visibility: "internal",
      operationPattern: "^(GET|POST) /api/v1/model-admin/ai/proposals(?:/.*)?$",
    },
  ],
};
if (existingControl >= 0) baseline.contractSources[existingControl] = controlSource;
else baseline.contractSources.splice(baseline.contractSources.findIndex((entry) => entry.id === "core-platform-admin"), 0, controlSource);
await write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  kernelVersion: kernel.info.version,
  kernelOperations: operations(kernel).length,
  kernelDigest: operationDigest(kernel),
  modelControlVersion: modelControl.info.version,
  modelControlOperations: operations(modelControl).length,
  modelControlDigest: operationDigest(modelControl),
  platformAdminVersion: "0.2.0",
}, null, 2));
