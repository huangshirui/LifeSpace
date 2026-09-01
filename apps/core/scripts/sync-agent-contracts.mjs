import fs from "node:fs";
import YAML from "yaml";

const coreOpenApiUrl = new URL("../openapi.yaml", import.meta.url);
const identityOpenApiUrl = new URL("../../identity/openapi.yaml", import.meta.url);
const corePackageUrl = new URL("../package.json", import.meta.url);
const identityPackageUrl = new URL("../../identity/package.json", import.meta.url);
const identityApplicationAdminUrl = new URL("../../identity/src/application-admin.ts", import.meta.url);
const coreCheckUrl = new URL("./check-openapi.mjs", import.meta.url);
const identityCheckUrl = new URL("../../identity/scripts/check-openapi.mjs", import.meta.url);
const contractsDocUrl = new URL("../../../docs/contracts.md", import.meta.url);
const serviceAuthDocUrl = new URL("../../../docs/service-authentication.md", import.meta.url);
const rootAgentsUrl = new URL("../../../AGENTS.md", import.meta.url);
const coreAgentsUrl = new URL("../AGENTS.md", import.meta.url);
const identityAgentsUrl = new URL("../../identity/AGENTS.md", import.meta.url);
const handoffCheckUrl = new URL("../../../packages/contracts/scripts/check-homemew-handoff.mjs", import.meta.url);

function read(url) { return fs.readFileSync(url, "utf8"); }
function write(url, value) { fs.writeFileSync(url, value); }
function replaceRequired(value, oldText, newText, label) {
  if (!value.includes(oldText)) throw new Error(`Could not find ${label}`);
  return value.replace(oldText, newText);
}
function response(schemaRef) {
  return { description: "Success", content: { "application/json": { schema: { $ref: schemaRef } } } };
}
const errors = {
  "400": { $ref: "#/components/responses/InvalidRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
};

// Core Kernel 0.17.0: Agent Delegation + governed Change History.
const core = YAML.parse(read(coreOpenApiUrl));
core.info.version = "0.17.0";
core.info.description = "Stable LifeSpace Core Kernel contract for Space, membership, invitations, Data Grants, Agent Delegations, governed Change History, authorized Runtime Discovery, webhook endpoints, event subscriptions, model administration, assets and Registry-driven Creation Draft orchestration. Ordinary business-model routes are intentionally not declared here; each published Model Registry state produces an immutable Model Contract Revision (mct_<sha256>) containing its concrete CRUD/query/action/Capability OpenAPI and JSON Schema.";
for (const name of ["Agent Delegations", "Change History"]) {
  if (!core.tags.some((tag) => tag.name === name)) core.tags.push({ name });
}
core.paths["/api/v1/spaces/{spaceId}/agent-delegations"] = {
  parameters: [{ $ref: "#/components/parameters/SpaceId" }],
  get: {
    tags: ["Agent Delegations"],
    operationId: "listAgentDelegations",
    description: "Lists Delegations created by the direct authenticated user in this application context and Space. Agent execution credentials cannot manage Delegations.",
    responses: {
      "200": response("#/components/schemas/AgentDelegationListResponse"),
      "401": errors["401"], "403": errors["403"], "404": errors["404"],
    },
  },
  post: {
    tags: ["Agent Delegations"],
    operationId: "createAgentDelegation",
    description: "Creates a revocable User -> Agent Delegation for the current application and Space. Every delegated model/access ceiling is checked against the direct user's current effective model authority before commit. Delegation can only narrow authority and is rechecked again at Agent execution time.",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateAgentDelegationRequest" } } } },
    responses: {
      "201": response("#/components/schemas/AgentDelegationResponse"),
      "400": errors["400"], "401": errors["401"], "403": errors["403"], "404": errors["404"],
    },
  },
};
core.paths["/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}"] = {
  parameters: [
    { $ref: "#/components/parameters/SpaceId" },
    { name: "delegationId", in: "path", required: true, schema: { type: "string", pattern: "^dlg_" } },
  ],
  delete: {
    tags: ["Agent Delegations"],
    operationId: "revokeAgentDelegation",
    description: "Immediately revokes the direct user's active Delegation in this application context. Subsequent Agent authorization fails even when a previously issued short-lived Agent token has not expired.",
    responses: { "204": { description: "Delegation revoked" }, "401": errors["401"], "403": errors["403"], "404": errors["404"] },
  },
};
core.paths["/api/v1/spaces/{spaceId}/changes/{recordId}"] = {
  parameters: [
    { $ref: "#/components/parameters/SpaceId" },
    { name: "recordId", in: "path", required: true, schema: { type: "string", pattern: "^rec_" } },
  ],
  get: {
    tags: ["Change History"],
    operationId: "getResourceChangeHistory",
    description: "Returns append-only governed Change evidence for one ordinary model record. Read authority is rechecked against the record's current published model; delegated Agent callers remain bounded by their current Delegation.",
    responses: { "200": response("#/components/schemas/ResourceChangeListResponse"), "401": errors["401"], "403": errors["403"], "404": errors["404"] },
  },
};
const cs = core.components.schemas;
cs.StatusResponse.properties.data.properties.contractVersion.const = "0.17.0";
cs.AgentDelegationModelAccess = {
  type: "object", additionalProperties: false, required: ["modelKey", "maxAccess"],
  properties: {
    modelKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" },
    maxAccess: { type: "string", enum: ["read", "write", "manage"] },
  },
};
cs.AgentDelegation = {
  type: "object", additionalProperties: false,
  required: ["id", "agentId", "applicationId", "spaceId", "models", "createdAt", "expiresAt", "revokedAt"],
  properties: {
    id: { type: "string", pattern: "^dlg_" },
    agentId: { type: "string", pattern: "^agt_" },
    applicationId: { type: "string", minLength: 1 },
    spaceId: { type: "string", pattern: "^spc_" },
    models: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/AgentDelegationModelAccess" } },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    revokedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
};
cs.CreateAgentDelegationRequest = {
  type: "object", additionalProperties: false, required: ["agentId", "models"],
  properties: {
    agentId: { type: "string", pattern: "^agt_" },
    models: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { $ref: "#/components/schemas/AgentDelegationModelAccess" } },
    expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
};
cs.AgentDelegationResponse = { type: "object", additionalProperties: false, required: ["data"], properties: { data: { $ref: "#/components/schemas/AgentDelegation" } } };
cs.AgentDelegationListResponse = {
  type: "object", additionalProperties: false, required: ["data"],
  properties: { data: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/AgentDelegation" } } } } },
};
cs.ResourceChangeActor = {
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: { type: { type: "string", enum: ["user", "service", "device", "agent"] }, id: { type: "string", minLength: 1 } },
};
cs.ResourceChangePrincipal = {
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: { type: { $ref: "#/components/schemas/PrincipalType" }, id: { type: "string", minLength: 1 } },
};
cs.ResourceChange = {
  type: "object", additionalProperties: false,
  required: ["id", "recordId", "spaceId", "modelKey", "operation", "versionBefore", "versionAfter", "principal", "actor", "applicationId", "delegationId", "changedFields", "occurredAt"],
  properties: {
    id: { type: "string", pattern: "^chg_" }, recordId: { type: "string", pattern: "^rec_" }, spaceId: { type: "string", pattern: "^spc_" },
    modelKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" }, operation: { type: "string", enum: ["create", "update", "action", "delete"] },
    versionBefore: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, versionAfter: { type: "integer", minimum: 1 },
    principal: { $ref: "#/components/schemas/ResourceChangePrincipal" }, actor: { $ref: "#/components/schemas/ResourceChangeActor" },
    applicationId: { type: "string", minLength: 1 }, delegationId: { anyOf: [{ type: "string", pattern: "^dlg_" }, { type: "null" }] },
    changedFields: { type: "array", uniqueItems: true, items: { type: "string" } }, occurredAt: { type: "string", format: "date-time" },
  },
};
cs.ResourceChangeListResponse = {
  type: "object", additionalProperties: false, required: ["data"],
  properties: { data: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/ResourceChange" } } } } },
};
write(coreOpenApiUrl, `${JSON.stringify(core)}\n`);

// Identity Application Contract 0.6.0. Preserve the human-maintained YAML layout by targeted insertion.
let identity = read(identityOpenApiUrl);
identity = replaceRequired(identity, "  version: 0.5.0", "  version: 0.6.0", "Identity OpenAPI version");
identity = replaceRequired(
  identity,
  "  description: Global LifeSpace user identity, profile, trusted application exchange, Cloudflare Access principal resolution/linking, application credential lifecycle, service principals and credential issuance API.",
  "  description: Global LifeSpace user identity, profile, trusted application exchange, Cloudflare Access principal resolution/linking, application credential lifecycle, Agent identity/execution-token issuance, service principals and credential issuance API.",
  "Identity OpenAPI description",
);
const identityAgentPaths = `  /internal/v1/agents:\n    get:\n      description: List active Agent identities bound to the authenticated trusted application. Agent identity is distinct from user Principal authority.\n      security: [{ applicationCredential: [] }]\n      responses:\n        '200': { description: Application Agent identities, content: { application/json: { schema: { $ref: '#/components/schemas/AgentListResponse' } } } }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n    post:\n      description: Create an Agent identity and bind it to the authenticated trusted application. This creates identity only and grants no Space/model authority.\n      security: [{ applicationCredential: [] }]\n      requestBody:\n        required: true\n        content: { application/json: { schema: { $ref: '#/components/schemas/CreateAgentRequest' } } }\n      responses:\n        '201': { description: Agent identity created, content: { application/json: { schema: { $ref: '#/components/schemas/AgentResponse' } } } }\n        '400': { $ref: '#/components/responses/InvalidRequest' }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '422': { $ref: '#/components/responses/ValidationError' }\n  /internal/v1/agent-tokens:\n    post:\n      description: Issue a short-lived Core-only delegated Agent execution JWT for an active user and an active Agent bound to the calling application. Identity authenticates the application and Agent identity, but Core remains authoritative for current User -> Agent Delegation and Space/model authorization on every execution. The token uses purpose=delegated_agent and never carries lifespace-identity audience.\n      security: [{ applicationCredential: [] }]\n      requestBody:\n        required: true\n        content: { application/json: { schema: { $ref: '#/components/schemas/AgentTokenRequest' } } }\n      responses:\n        '200': { description: Core-only delegated Agent execution token, content: { application/json: { schema: { $ref: '#/components/schemas/AgentTokenResponse' } } } }\n        '400': { $ref: '#/components/responses/InvalidRequest' }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '422': { $ref: '#/components/responses/ValidationError' }\n`;
identity = replaceRequired(identity, "  /api/v1/service-principals:\n", `${identityAgentPaths}  /api/v1/service-principals:\n`, "Identity service-principal path anchor");
const identityAgentSchemas = `    Agent:\n      type: object\n      additionalProperties: false\n      required: [id, displayName, status, createdAt, updatedAt]\n      properties:\n        id: { type: string, pattern: ^agt_ }\n        displayName: { type: string, minLength: 1, maxLength: 100 }\n        status: { type: string, enum: [active, disabled] }\n        createdAt: { type: string, format: date-time }\n        updatedAt: { type: string, format: date-time }\n    CreateAgentRequest:\n      type: object\n      additionalProperties: false\n      required: [displayName]\n      properties:\n        displayName: { type: string, minLength: 1, maxLength: 100 }\n    AgentResponse:\n      type: object\n      additionalProperties: false\n      required: [data]\n      properties:\n        data: { $ref: '#/components/schemas/Agent' }\n    AgentListResponse:\n      type: object\n      additionalProperties: false\n      required: [data]\n      properties:\n        data:\n          type: object\n          additionalProperties: false\n          required: [items]\n          properties:\n            items: { type: array, items: { $ref: '#/components/schemas/Agent' } }\n    AgentTokenRequest:\n      type: object\n      additionalProperties: false\n      required: [subjectId, agentId]\n      properties:\n        subjectId: { type: string, pattern: ^usr_ }\n        agentId: { type: string, pattern: ^agt_ }\n        scopes: { type: array, uniqueItems: true, items: { type: string, minLength: 1, maxLength: 100 }, default: [] }\n    AgentTokenResponse:\n      type: object\n      additionalProperties: false\n      required: [data]\n      properties:\n        data:\n          type: object\n          additionalProperties: false\n          required: [accessToken, tokenType, expiresIn, scope, principalId, actor, applicationId]\n          properties:\n            accessToken: { type: string, writeOnly: true }\n            tokenType: { const: Bearer }\n            expiresIn: { type: integer, minimum: 1, maximum: 900 }\n            scope: { type: string }\n            principalId: { type: string, pattern: ^usr_ }\n            actor:\n              type: object\n              additionalProperties: false\n              required: [type, id]\n              properties:\n                type: { const: agent }\n                id: { type: string, pattern: ^agt_ }\n            applicationId: { type: string, minLength: 1 }\n`;
identity = replaceRequired(identity, "  schemas:\n    ErrorResponse:\n", `  schemas:\n${identityAgentSchemas}    ErrorResponse:\n`, "Identity schemas anchor");
write(identityOpenApiUrl, identity);

// Package/runtime/check versions.
for (const [url, version] of [[corePackageUrl, "0.17.0"], [identityPackageUrl, "0.6.0"]]) {
  const pkg = JSON.parse(read(url));
  pkg.version = version;
  write(url, `${JSON.stringify(pkg, null, 2)}\n`);
}
let identityAdmin = read(identityApplicationAdminUrl);
identityAdmin = replaceRequired(identityAdmin, 'export const IDENTITY_CONTRACT_VERSION = "0.5.0";', 'export const IDENTITY_CONTRACT_VERSION = "0.6.0";', "Identity runtime contract constant");
write(identityApplicationAdminUrl, identityAdmin);

let coreCheck = read(coreCheckUrl);
coreCheck = replaceRequired(coreCheck, 'document.info?.version !== "0.16.0"', 'document.info?.version !== "0.17.0"', "Core check version");
coreCheck = replaceRequired(coreCheck, '  "/api/v1/spaces/{spaceId}/_discovery",\n', '  "/api/v1/spaces/{spaceId}/_discovery",\n  "/api/v1/spaces/{spaceId}/agent-delegations",\n  "/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}",\n  "/api/v1/spaces/{spaceId}/changes/{recordId}",\n', "Core required paths");
coreCheck += `\nconst agentDelegations = document.paths?.["/api/v1/spaces/{spaceId}/agent-delegations"];\nif (!agentDelegations?.get || !agentDelegations?.post || !document.paths?.["/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}"]?.delete) {\n  throw new Error("Agent Delegation lifecycle is incomplete");\n}\nif (JSON.stringify(schemas.AgentDelegationModelAccess?.properties?.maxAccess?.enum) !== JSON.stringify(["read", "write", "manage"])) {\n  throw new Error("Agent Delegation must use the stable read/write/manage ceiling");\n}\nif (!schemas.ResourceChangeActor?.properties?.type?.enum?.includes("agent") || !schemas.ResourceChange?.required?.includes("delegationId")) {\n  throw new Error("Governed Change contract must preserve Agent actor and Delegation attribution");\n}\n`;
write(coreCheckUrl, coreCheck);

let identityCheck = read(identityCheckUrl);
identityCheck = replaceRequired(identityCheck, 'doc.info?.version !== "0.5.0"', 'doc.info?.version !== "0.6.0"', "Identity check version");
identityCheck = replaceRequired(identityCheck, '  "/api/v1/service-principals",\n', '  "/internal/v1/agents",\n  "/internal/v1/agent-tokens",\n  "/api/v1/service-principals",\n', "Identity required agent paths");
identityCheck += `\nconst agentTokenPost = doc.paths?.["/internal/v1/agent-tokens"]?.post;\nif (!String(agentTokenPost?.description ?? "").includes("Core-only") || !String(agentTokenPost?.description ?? "").includes("Delegation")) {\n  throw new Error("Agent token contract must remain Core-only and delegate current authority to Core");\n}\nif (doc.components?.schemas?.Agent?.properties?.id?.pattern !== "^agt_" || doc.components?.schemas?.AgentTokenResponse?.properties?.data?.properties?.actor?.properties?.type?.const !== "agent") {\n  throw new Error("Identity Agent contract must expose stable agt_* identity and actor semantics");\n}\n`;
write(identityCheckUrl, identityCheck);

// Preserve accepted downstream contract pins instead of silently repinning HomeMew when platform contracts advance.
let handoffCheck = read(handoffCheckUrl);
handoffCheck = replaceRequired(handoffCheck,
  'assert.equal(profile.contracts?.coreKernel, corePackage.version, "HomeMew Core pin must match repository Core version");\nassert.equal(profile.contracts?.identity, identityPackage.version, "HomeMew Identity pin must match repository Identity version");',
  'assert.match(profile.contracts?.coreKernel ?? "", /^\\d+\\.\\d+\\.\\d+$/u, "HomeMew Core pin must be an explicit semantic version");\nassert.match(profile.contracts?.identity ?? "", /^\\d+\\.\\d+\\.\\d+$/u, "HomeMew Identity pin must be an explicit semantic version");\nassert.notEqual(profile.contracts?.coreKernel, "", "HomeMew Core pin must remain explicit");\nassert.notEqual(profile.contracts?.identity, "", "HomeMew Identity pin must remain explicit");\n// Accepted application pins are immutable compatibility evidence and do not silently follow later platform package versions.\nvoid corePackage;\nvoid identityPackage;',
  "HomeMew independent contract pin assertions",
);
write(handoffCheckUrl, handoffCheck);

// Documentation and local coding instructions.
let contractsDoc = read(contractsDocUrl);
contractsDoc = replaceRequired(contractsDoc, 'Its current version remains `0.5.0`.', 'Its current version is `0.6.0`; 0.6.0 adds first-class Agent identity and Core-only delegated Agent execution-token issuance.', "contracts Identity current version");
contractsDoc = replaceRequired(contractsDoc, 'As of Core Kernel `0.15.0`, ordinary model paths/schemas remain deliberately absent', 'As of Core Kernel `0.17.0`, ordinary model paths/schemas remain deliberately absent', "contracts Core current version anchor");
contractsDoc = replaceRequired(contractsDoc, 'Kernel `0.15.0` separates reusable Webhook Endpoint transport/signing from model/event subscription filters so multiple models can share one callback and signing secret.', 'Kernel `0.15.0` separates reusable Webhook Endpoint transport/signing from model/event subscription filters so multiple models can share one callback and signing secret. Kernel `0.16.0` adds owner-only logical Space close. Kernel `0.17.0` adds User -> Agent Delegation management and governed Change History while leaving ordinary model CRUD/action syntax in immutable `mct_*` contracts.', "contracts Kernel history");
contractsDoc = replaceRequired(contractsDoc, '- health/status and authentication-facing Core principal behavior;\n', '- health/status and authentication-facing Core principal behavior;\n- User -> Agent Delegation lifecycle and governed Change History;\n', "contracts Kernel capability list");
contractsDoc += '\n### Agent-ready contract split — 0.6.0 / 0.17.0\n\nIdentity Application Contract `0.6.0` owns Agent identity (`agt_*`) and trusted-application issuance of short-lived `purpose=delegated_agent` execution JWTs whose audience is Core only. Core Kernel `0.17.0` owns User -> Agent Delegation current state, Delegation-bounded Runtime Discovery/authorization and governed Change History. Identity does not read Core Delegations; a valid Agent JWT is therefore necessary but never sufficient authority. Core rechecks the mutable Delegation and all existing authorization layers at execution time. Existing accepted downstream tuples remain pinned evidence and must not be silently rewritten merely because the platform publishes a newer compatible contract.\n';
write(contractsDocUrl, contractsDoc);

let serviceDoc = read(serviceAuthDocUrl);
serviceDoc = replaceRequired(serviceDoc, '## `lsa_*` is not a service token\n', '## Delegated Agent execution is not service automation\n\nAn Agent acting under a user\'s authority uses a distinct execution context from a `service` principal. Identity registers a stable Agent identity (`agt_*`) inside an application context and may issue a short-lived Core-only JWT carrying `principal_type=user`, `actor_type=agent`, `actor_id=agt_*` and `purpose=delegated_agent`. Core then intersects that credential with the user\'s current Space/model authority and an explicit current User -> Agent Delegation.\n\nThe Agent token does not grant authority by itself, cannot be reused against Identity user-profile APIs, and does not turn the Agent into a Space member. Revoking the Core Delegation blocks later requests immediately even if the short-lived token remains cryptographically valid.\n\n## `lsa_*` is not a service token\n', "service auth Agent section");
write(serviceAuthDocUrl, serviceDoc);

let rootAgents = read(rootAgentsUrl);
rootAgents = replaceRequired(rootAgents, '6. `docs/contracts.md`;\n7. `docs/model-definition-spec.md`', '6. `docs/contracts.md`;\n7. `docs/agent-ready.md` for Principal / Actor / Delegation / governed Change rules when changing Agent-facing authority;\n8. `docs/model-definition-spec.md`', "root AGENTS read list");
rootAgents = rootAgents.replace('8. `docs/phase3-metadata-platform-plan.md`', '9. `docs/phase3-metadata-platform-plan.md`').replace('9. `docs/phase3-performance-convergence-plan.md`', '10. `docs/phase3-performance-convergence-plan.md`').replace('10. `docs/migration-plan.md`', '11. `docs/migration-plan.md`').replace('11. `apps/AGENTS.md`', '12. `apps/AGENTS.md`').replace('12. relevant OpenAPI', '13. relevant OpenAPI');
rootAgents = replaceRequired(rootAgents, '- Contract ownership/versioning/publication/downstream consumption: `docs/contracts.md`\n', '- Contract ownership/versioning/publication/downstream consumption: `docs/contracts.md`\n- Agent execution-context, Delegation and governed Change invariants: `docs/agent-ready.md`\n', "root AGENTS source of truth");
write(rootAgentsUrl, rootAgents);

let coreAgents = read(coreAgentsUrl);
coreAgents = coreAgents.replace(/current version: `0\.16\.0`/g, 'current version: `0.17.0`');
write(coreAgentsUrl, coreAgents);
let identityAgents = read(identityAgentsUrl);
identityAgents = identityAgents.replace(/current version: 0\.5\.0/g, 'current version: 0.6.0');
identityAgents = replaceRequired(identityAgents, '- global LifeSpace users (`usr_*`);\n', '- global LifeSpace users (`usr_*`);\n- stable Agent identities (`agt_*`) and their application binding;\n- Core-only short-lived delegated Agent execution-token issuance;\n', "Identity AGENTS responsibilities");
write(identityAgentsUrl, identityAgents);

console.log(JSON.stringify({ ok: true, coreKernel: core.info.version, identity: "0.6.0" }));
