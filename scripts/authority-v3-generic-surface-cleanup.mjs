import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function read(file) { return fs.readFileSync(file, "utf8"); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceIn(file, replacer) {
  if (!fs.existsSync(file)) return;
  const before = read(file);
  const after = replacer(before);
  if (after !== before) write(file, after);
}

// Core Kernel OpenAPI is checked in as canonical minified JSON despite .yaml suffix.
{
  const file = "apps/core/openapi.yaml";
  let api = JSON.parse(read(file));
  api.info.version = "0.42.0";
  let raw = JSON.stringify(api)
    .replaceAll("Agent Delegations", "Delegations")
    .replaceAll("AgentDelegation", "Delegation")
    .replaceAll("/agent-delegations", "/delegations")
    .replaceAll("listAgentDelegations", "listDelegations")
    .replaceAll("createAgentDelegation", "createDelegation")
    .replaceAll("revokeAgentDelegation", "revokeDelegation")
    .replaceAll("Agent Delegation", "Delegation");
  api = JSON.parse(raw);
  api.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.42.0";
  const schemas = api.components.schemas;
  schemas.DelegationActor = {
    type: "object",
    additionalProperties: false,
    required: ["type", "id"],
    properties: {
      type: { $ref: "#/components/schemas/PrincipalType" },
      id: { type: "string", minLength: 1 },
    },
    description: "Actor receiving this Delegation. Runtime support is additionally bounded by Entity Role Capability.canReceiveDelegation.",
  };
  const delegation = schemas.Delegation;
  delegation.required = delegation.required.map((value) => value === "agentId" ? "actor" : value);
  delete delegation.properties.agentId;
  delegation.properties.actor = { $ref: "#/components/schemas/DelegationActor" };
  const create = schemas.CreateDelegationRequest;
  create.required = create.required.map((value) => value === "agentId" ? "actor" : value);
  delete create.properties.agentId;
  create.properties.actor = { $ref: "#/components/schemas/DelegationActor" };

  const collection = api.paths["/api/v1/spaces/{spaceId}/delegations"];
  collection.get.description = "Lists Delegations rooted in the direct Principal for this Application and source Space. Represented execution cannot use listing as Delegation discovery.";
  collection.post.description = "Creates one immutable-scope Delegation. A direct eligible Principal creates a Root Delegation from its own current Authority. A represented Actor may create a Child only from an explicit parent that permits re-delegation; Core preserves the Root Principal and enforces strict narrowing. The requested Actor type must currently allow canReceiveDelegation. Child issuance does not consume a single-use parent.";
  const item = api.paths["/api/v1/spaces/{spaceId}/delegations/{delegationId}"];
  item.delete.description = "Revokes one active Delegation. The direct Root Principal may revoke any Delegation in its rooted chain. The immediate issuer may revoke a Child Delegation it created. Descendants are not cascade-updated; current-state chain resolution invalidates them when an ancestor is revoked.";
  write(file, JSON.stringify(api));
}

// Identity Agent execution contract: one current profile, no unused legacy subjectId/delegated_agent syntax.
replaceIn("apps/identity/openapi.yaml", (text) => text
  .replace("version: 0.7.0", "version: 0.8.0")
  .replace("const: 0.7.0", "const: 0.8.0")
  .replaceAll("/internal/v1/agent-tokens", "/internal/v1/agent-execution-tokens")
  .replace(/description: Issue a short-lived Core-only Agent execution JWT\.[^\n]*/,
    "description: Issue one short-lived Core-only Agent Execution Token. sub authenticates the actual Agent Actor; Principal is an independent signed claim. Omitting principalType/principalId means direct Agent execution. Current executable Principal types are user and agent; Core remains authoritative for Delegation and business Authority.")
  .replace(/\s+subjectId: \{ type: string, pattern: \^usr_ \}\n/, "\n")
  .replace(/\s+description: Legacy callers may send subjectId[^\n]*\n/, "\n      description: Omit principalType/principalId for direct Agent execution; otherwise provide both. Current executable Principal types are user and agent.\n")
  .replace("purpose: { type: string, enum: [delegated_agent, agent_execution] }", "purpose: { type: string, const: agent_execution }")
);

replaceIn("apps/identity/src/application-admin.ts", (text) => text.replace(
  'export const IDENTITY_CONTRACT_VERSION = "0.7.0";',
  'export const IDENTITY_CONTRACT_VERSION = "0.8.0";',
));
replaceIn("apps/core/src/app.ts", (text) => text.replace(
  'schemaVersion: await schemaVersion(context.env), contractVersion: "0.41.0",',
  'schemaVersion: await schemaVersion(context.env), contractVersion: "0.42.0",',
));

const grep = (needle, dirs) => {
  try {
    return execFileSync("git", ["grep", "-l", needle, "--", ...dirs], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
};

const currentAreas = [
  "apps/core/test", "apps/core/scripts", "apps/core/AGENTS.md",
  "apps/identity/test", "apps/identity/scripts", "apps/identity/AGENTS.md",
  "infra/scripts", ".github/workflows", "README.md",
  "docs/agent-ready.md", "docs/permissions.md", "docs/contracts.md",
  "docs/architecture.md", "docs/service-authentication.md",
  "docs/authority-role-capability-redelegation.md", "docs/contract-stability-baseline.json",
];

const routeFiles = new Set([
  ...grep("agent-delegations", currentAreas),
  ...grep("agent-tokens", currentAreas),
]);
for (const file of routeFiles) {
  if (file === "apps/core/openapi.yaml" || file === "apps/identity/openapi.yaml") continue;
  replaceIn(file, (text) => text
    .replaceAll("/agent-delegations", "/delegations")
    .replaceAll("/internal/v1/agent-tokens", "/internal/v1/agent-execution-tokens")
  );
}

// Core tests/staging helpers previously built Agent-specific Delegation request bodies.
const coreDelegationFiles = grep("/delegations", ["apps/core/test", "apps/core/scripts", "infra/scripts"]);
for (const file of coreDelegationFiles) {
  replaceIn(file, (text) => text
    .replace(/\bagentId\s*,(?=\s*(?:\r?\n\s*)?(?:parentDelegationId|scope)\s*[:,])/g,
      'actor: { type: "agent", id: agentId },')
    .replace(/\bagentId:\s*([A-Za-z_$][A-Za-z0-9_$.[\]!-]*)\s*,(?=\s*(?:\r?\n\s*)?(?:parentDelegationId|scope)\s*[:,])/g,
      'actor: { type: "agent", id: $1 },')
  );
}

for (const file of [
  "docs/agent-ready.md", "docs/permissions.md", "docs/service-authentication.md",
  "docs/authority-role-capability-redelegation.md", "apps/identity/AGENTS.md",
]) {
  replaceIn(file, (text) => text
    .replaceAll("purpose=delegated_agent", "purpose=agent_execution")
    .replaceAll("`purpose=delegated_agent`", "`purpose=agent_execution`")
  );
}

for (const file of ["apps/core/AGENTS.md", "docs/contracts.md"]) {
  replaceIn(file, (text) => text.replaceAll("0.41.0", "0.42.0"));
}
for (const file of ["apps/identity/AGENTS.md", "docs/contracts.md"]) {
  replaceIn(file, (text) => text.replaceAll("0.7.0", "0.8.0"));
}

// This is a deliberate Candidate Public breaking cleanup. No Stable operation-group
// digest changed; refresh only the two code-owned operation-set digests affected by
// retiring the unused Agent-specific routes, and align the Candidate group name.
{
  const file = "docs/contract-stability-baseline.json";
  const baseline = JSON.parse(read(file));
  const identity = baseline.contractSources.find((entry) => entry.id === "identity-application");
  const core = baseline.contractSources.find((entry) => entry.id === "core-kernel");
  if (!identity || !core) throw new Error("Contract stability baseline is missing Identity/Core sources");
  identity.operationSetSha256 = "sha256:5c0c96b33e541439b63f27cfa9c4b3f56720838580139ad167b17aaf8b2d92f7";
  core.operationSetSha256 = "sha256:942920a88e65a0bb56ab8c3c7fbd968927aad2089796768d61577c46689b2c48";
  const delegationGroup = core.groups.find((group) => group.id === "core-agent-delegation" || group.id === "core-delegation");
  if (!delegationGroup) throw new Error("Core Delegation contract classification is missing");
  delegationGroup.id = "core-delegation";
  write(file, `${JSON.stringify(baseline, null, 2)}\n`);
}

console.log("Authority v3 generic surface cleanup complete");
