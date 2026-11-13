import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = file => readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
const identities = read("AgentIdentitiesDialog.tsx");
const agent = read("AgentCredentialsDialog.tsx");
const service = read("CredentialGovernanceOverlay.tsx");
const app = read("ApplicationConfigurationOverlay.tsx");
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const principalEditor = section(service, "function PrincipalEditor(", "function TokenManager(");
const tokenManager = section(service, "function TokenManager(", "function ServiceIdentitiesDialog(");
const principalList = section(service, "function ServiceIdentitiesDialog(", "export default function CredentialGovernanceOverlay");
const audience = section(app, "function AccessAudiencesDialog(", "export default function ApplicationConfigurationOverlay");

for (const [name, source] of [["Agent identities", identities], ["Agent credentials", agent], ["Service tokens", tokenManager], ["Access audiences", audience]]) {
  const list = source.slice(source.indexOf('return <ConsoleDialog key="list"'));
  assert.ok(list.startsWith('return <ConsoleDialog key="list"'), name + " must have a dedicated list");
  assert.ok(!/<(?:input|textarea|select)\b/.test(list), name + " list must not contain edit fields");
  assert.ok(source.includes("cancelEditor"), name + " editor needs cancellation");
}
assert.ok(identities.includes('if (creating) return <ConsoleDialog'));
assert.ok(identities.includes('if (editing) return <ConsoleDialog'));
assert.ok(identities.includes("confirmGlobalStatus: true"));
assert.ok(identities.includes("confirmAgentId: editing.id"));
assert.ok(agent.includes('if (creating || editing) return <ConsoleDialog'));
assert.ok(agent.includes("confirmCredentialId: editing.id"));
assert.ok(agent.includes("setRevealPath(result.revealPath)"));
assert.ok(principalEditor.includes("return <ConsoleDialog compact busy={busy}"));
assert.ok(principalList.includes("if (editor) return <PrincipalEditor"));
assert.ok(!/<(?:input|textarea|select)\b/.test(principalList));
assert.ok(tokenManager.includes('if (creating || editing) return <ConsoleDialog'));
assert.ok(tokenManager.includes("confirmTokenId: editing.id"));
assert.ok(tokenManager.includes("setRevealPath(result.revealPath)"));
assert.ok(audience.includes('if (registering) return <ConsoleDialog'));
assert.ok(audience.includes("confirmAudienceId: item.id"));
console.log("Console Application/Agent/Service independent editor flow checks passed");
