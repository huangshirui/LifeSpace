import fs from "node:fs";
import { execFileSync } from "node:child_process";

function replaceIn(file, replacer) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  const after = replacer(before);
  if (after !== before) fs.writeFileSync(file, after);
}

replaceIn("apps/core/test/authority-v3-boundaries.integration.test.ts", (text) => text
  .replaceAll('  actor: { type: "agent", id: string },\n  scope:', '  agentId: string,\n  scope:')
);

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

for (const file of [
  "apps/core/test/agent-ready.integration.test.ts",
  "apps/core/test/agent-task-workflow.integration.test.ts",
]) {
  replaceIn(file, (text) => text.replace(
    /sub: userId,\n(\s+)azp: ([^\n]+),\n\1principal_type: "user",\n\1actor_type: "agent",\n\1actor_id: agentId,\n\1purpose: "delegated_agent",/u,
    (_match, indent, azp) => `sub: agentId,\n${indent}azp: ${azp},\n${indent}principal_type: "user",\n${indent}principal_id: userId,\n${indent}actor_type: "agent",\n${indent}actor_id: agentId,\n${indent}purpose: "agent_execution",`,
  ));
}

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

for (const file of [
  "apps/core/test/authority-v2-performance.integration.test.ts",
  "apps/core/test/authority-v3-performance.integration.test.ts",
]) {
  replaceIn(file, (text) => text.replaceAll('purpose: "delegated_agent"', 'purpose: "agent_execution"'));
}

// Revoke authority regression: Root Principal may revoke any descendant in its rooted
// chain; a Child's immediate issuer may revoke that Child; unrelated represented
// Actors remain opaque and an issuer cannot revoke the Root merely by being its Actor.
replaceIn("apps/core/test/authority-v3-boundaries.integration.test.ts", (text) => {
  const title = '  it("allows Root Principal and immediate issuer revocation without widening management authority", async () => {';
  if (text.includes(title)) return text;
  const marker = '  it("supports the maximum depth and rejects propagation beyond it", async () => {';
  if (!text.includes(marker)) throw new Error("Authority v3 revoke-test insertion point not found");
  const test = `  it("allows Root Principal and immediate issuer revocation without widening management authority", async () => {\n    const { privateKey, publicKey } = await keys();\n    const userId = \`usr_\${crypto.randomUUID().replaceAll("-", "")}\`;\n    const agentA = \`agt_\${crypto.randomUUID().replaceAll("-", "")}\`;\n    const agentB = \`agt_\${crypto.randomUUID().replaceAll("-", "")}\`;\n    const agentC = \`agt_\${crypto.randomUUID().replaceAll("-", "")}\`;\n    const spaceId = \`spc_\${crypto.randomUUID().replaceAll("-", "")}\`;\n    await seed(userId, spaceId);\n\n    const direct = await token(privateKey, { principalType: "user", principalId: userId });\n    const rootResponse = await issueRoot(\n      publicKey,\n      direct,\n      spaceId,\n      agentA,\n      { target: { type: "model", id: "event" }, maxAccess: "write" },\n      { remainingRedelegationDepth: 1 },\n    );\n    expect(rootResponse.status).toBe(201);\n    const root = (await payload(rootResponse)).data;\n    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });\n\n    const childForIssuerResponse = await issueChild(\n      publicKey, representedA, spaceId, root.id, agentB,\n      { target: { type: "model", id: "event" }, maxAccess: "write" },\n      { remainingRedelegationDepth: 0 },\n    );\n    expect(childForIssuerResponse.status).toBe(201);\n    const childForIssuer = (await payload(childForIssuerResponse)).data;\n\n    const childForRootResponse = await issueChild(\n      publicKey, representedA, spaceId, root.id, agentC,\n      { target: { type: "model", id: "event" }, maxAccess: "write" },\n      { remainingRedelegationDepth: 0 },\n    );\n    expect(childForRootResponse.status).toBe(201);\n    const childForRoot = (await payload(childForRootResponse)).data;\n\n    const unrelated = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentC });\n    await expectError(await request(\n      publicKey,\n      \`/api/v1/spaces/\${spaceId}/delegations/\${childForIssuer.id}\`,\n      unrelated,\n      { method: "DELETE" },\n    ), 404, "DELEGATION_NOT_FOUND");\n\n    const issuerRevoke = await request(\n      publicKey,\n      \`/api/v1/spaces/\${spaceId}/delegations/\${childForIssuer.id}\`,\n      representedA,\n      { method: "DELETE" },\n    );\n    expect(issuerRevoke.status).toBe(204);\n\n    await expectError(await request(\n      publicKey,\n      \`/api/v1/spaces/\${spaceId}/delegations/\${root.id}\`,\n      representedA,\n      { method: "DELETE" },\n    ), 404, "DELEGATION_NOT_FOUND");\n\n    const rootRevoke = await request(\n      publicKey,\n      \`/api/v1/spaces/\${spaceId}/delegations/\${childForRoot.id}\`,\n      direct,\n      { method: "DELETE" },\n    );\n    expect(rootRevoke.status).toBe(204);\n\n    const rows = await (env as unknown as TestEnv).DB.prepare(\n      "SELECT id,revoked_at FROM delegations WHERE id IN (?,?) ORDER BY id",\n    ).bind(childForIssuer.id, childForRoot.id).all<{ id: string; revoked_at: string | null }>();\n    expect(rows.results).toHaveLength(2);\n    expect(rows.results.every((row) => row.revoked_at !== null)).toBe(true);\n  });\n\n`;
  return text.replace(marker, `${test}${marker}`);
});

replaceIn("apps/core/scripts/check-openapi.mjs", (text) => text
  .replaceAll('document.info?.version !== "0.41.0"', 'document.info?.version !== "0.42.0"')
  .replaceAll('contractVersion?.const !== "0.41.0"', 'contractVersion?.const !== "0.42.0"')
  .replaceAll("AgentDelegation", "Delegation")
  .replaceAll("Agent Delegation", "Delegation")
  .replaceAll("agentDelegations", "delegations")
  .replaceAll('required?.join(",") !== "agentId,scope"', 'required?.join(",") !== "actor,scope"')
);
replaceIn("apps/core/scripts/check-authority-contract.mjs", (text) => text
  .replaceAll("Agent Delegation", "Delegation")
  .replaceAll("AgentDelegation", "Delegation")
);

replaceIn("apps/identity/scripts/check-openapi.mjs", (text) => text
  .replaceAll('doc.info?.version !== "0.7.0"', 'doc.info?.version !== "0.8.0"')
  .replaceAll('contractVersion?.const !== "0.7.0"', 'contractVersion?.const !== "0.8.0"')
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
