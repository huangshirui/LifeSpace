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

// Identity checker should require only the unified endpoint/profile.
replaceIn("apps/identity/scripts/check-openapi.mjs", (text) => text
  .replaceAll("/internal/v1/agent-tokens", "/internal/v1/agent-execution-tokens")
  .replaceAll("delegated_agent", "agent_execution")
);

// Current runtime/docs naming, excluding immutable historical migrations/decisions.
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
  );
}

// Print remaining current-surface legacy references for CI logs. Historical decision/migration evidence is intentionally excluded.
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
