import fs from "node:fs";
import { execFileSync } from "node:child_process";

function replaceIn(file, replacer) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  const after = replacer(before);
  if (after !== before) fs.writeFileSync(file, after);
}

// Undo one over-broad mechanical replacement in helper parameter declarations.
replaceIn("apps/core/test/authority-v3-boundaries.integration.test.ts", (text) => text
  .replaceAll('  actor: { type: "agent", id: string },\n  scope:', '  agentId: string,\n  scope:')
);

// DTO assertions now use the generic actor object.
for (const file of [
  "apps/core/test/agent-ready.integration.test.ts",
  "apps/core/test/authority-v3-boundaries.integration.test.ts",
]) {
  replaceIn(file, (text) => text
    .replaceAll("delegation.agentId", "delegation.actor.id")
    .replaceAll("root.agentId", "root.actor.id")
    .replaceAll("child.agentId", "child.actor.id")
  );
}

// Required User -> Agent token helpers: sub authenticates the Agent Actor and
// principal_id preserves the independent Root User Principal.
for (const file of [
  "apps/core/test/agent-ready.integration.test.ts",
  "apps/core/test/agent-task-workflow.integration.test.ts",
]) {
  replaceIn(file, (text) => text.replace(
    /sub: userId,\n(\s+)azp: ([^\n]+),\n\1principal_type: "user",\n\1actor_type: "agent",\n\1actor_id: agentId,\n\1purpose: "delegated_agent",/u,
    (_match, indent, azp) => `sub: agentId,\n${indent}azp: ${azp},\n${indent}principal_type: "user",\n${indent}principal_id: userId,\n${indent}actor_type: "agent",\n${indent}actor_id: agentId,\n${indent}purpose: "agent_execution",`,
  ));
}

// Optional represented-token helpers retain the direct User branch.
for (const file of [
  "apps/core/test/authority-v2.integration.test.ts",
  "apps/core/test/performance-budget.integration.test.ts",
]) {
  replaceIn(file, (text) => text
    .replace("    sub: userId,", "    sub: agentId ?? userId,")
    .replace(
      '    ...(agentId ? {\n      actor_type: "agent",\n      actor_id: agentId,\n      purpose: "delegated_agent",\n    } : {}),',
      '    ...(agentId ? {\n      principal_id: userId,\n      actor_type: "agent",\n      actor_id: agentId,\n      purpose: "agent_execution",\n    } : {}),',
    )
  );
}
replaceIn("apps/core/test/batch-runtime.integration.test.ts", (text) => text
  .replace("sub: userId, azp:", "sub: agentId ?? userId, azp:")
  .replace(
    '...(agentId ? { actor_type: "agent", actor_id: agentId, purpose: "delegated_agent" } : {}),',
    '...(agentId ? { principal_id: userId, actor_type: "agent", actor_id: agentId, purpose: "agent_execution" } : {}),',
  )
);

// Discovery helpers can serve direct callers and represented User callers.
for (const file of [
  "apps/core/test/runtime-discovery-inventory.integration.test.ts",
  "apps/core/test/runtime-model-semantic-detail.integration.test.ts",
]) {
  replaceIn(file, (text) => text
    .replace("    sub: principalId,", "    sub: actor?.id ?? principalId,")
    .replace(
      '    ...(actor ? { actor_type: "agent", actor_id: actor.id, purpose: "delegated_agent" } : {}),',
      '    ...(actor ? { principal_id: principalId, actor_type: "agent", actor_id: actor.id, purpose: "agent_execution" } : {}),',
    )
  );
}

// In-memory Principal fixtures do not encode JWT shape; only the marker changes.
for (const file of [
  "apps/core/test/authority-v2-performance.integration.test.ts",
  "apps/core/test/authority-v3-performance.integration.test.ts",
]) {
  replaceIn(file, (text) => text.replaceAll('purpose: "delegated_agent"', 'purpose: "agent_execution"'));
}

// Contract checker terminology/schema names follow the generic public surface.
replaceIn("apps/core/scripts/check-openapi.mjs", (text) => text
  .replaceAll("AgentDelegation", "Delegation")
  .replaceAll("Agent Delegation", "Delegation")
  .replaceAll("agentDelegations", "delegations")
);
replaceIn("apps/core/scripts/check-authority-contract.mjs", (text) => text
  .replaceAll("Agent Delegation", "Delegation")
  .replaceAll("AgentDelegation", "Delegation")
);

replaceIn("apps/identity/scripts/check-openapi.mjs", (text) => text
  .replaceAll("/internal/v1/agent-tokens", "/internal/v1/agent-execution-tokens")
  .replaceAll("delegated_agent", "agent_execution")
);

for (const file of [
  "docs/agent-ready.md",
  "docs/permissions.md",
  "docs/service-authentication.md",
  "docs/authority-role-capability-redelegation.md",
  "apps/core/AGENTS.md",
  "apps/identity/AGENTS.md",
]) {
  replaceIn(file, (text) => text
    .replaceAll("Agent Delegation management", "Delegation management")
    .replaceAll("Agent Delegations", "Delegations")
    .replaceAll("Agent Delegation", "Delegation")
    .replaceAll("delegated_agent", "agent_execution")
  );
}

const grep = (pattern, areas) => {
  try {
    return execFileSync("git", ["grep", "-nE", pattern, "--", ...areas], { encoding: "utf8" }).trim();
  } catch { return ""; }
};
const legacy = grep("agent-delegations|/internal/v1/agent-tokens|delegated_agent|AgentDelegation", [
  "apps/core/src", "apps/core/test", "apps/core/scripts", "apps/core/openapi.yaml",
  "apps/identity/src", "apps/identity/test", "apps/identity/scripts", "apps/identity/openapi.yaml",
  "infra/scripts", ".github/workflows/staging-deploy.yml",
  "docs/agent-ready.md", "docs/permissions.md", "docs/service-authentication.md",
  "docs/authority-role-capability-redelegation.md",
]);
if (legacy) {
  console.error("Legacy current-surface references remain:\n" + legacy);
  process.exitCode = 1;
} else {
  console.log("No legacy current-surface Agent Delegation/token references remain");
}
