import fs from "node:fs";

const worker = fs.readFileSync(new URL("../worker/agent-governance.ts", import.meta.url), "utf8");
const externalConnectionsWorker = fs.readFileSync(new URL("../worker/external-connections.ts", import.meta.url), "utf8");
const overlay = fs.readFileSync(new URL("../src/AgentIdentitiesDialog.tsx", import.meta.url), "utf8");
const applicationOverlay = fs.readFileSync(new URL("../src/ApplicationConfigurationOverlay.tsx", import.meta.url), "utf8");
const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

for (const required of [
  'import configurationCenterWorker from "./configuration-center"',
  '"x-lifespace-actor-token"',
  'IDENTITY_APPLICATION_CREDENTIAL',
  'create-agent-identity',
  'update-agent-identity',
  'confirmApplicationId',
  'confirmAgentId',
  'confirmGlobalStatus',
  '/internal/v1/platform-admin/applications/',
]) {
  if (!worker.includes(required)) throw new Error(`Agent governance BFF missing boundary marker: ${required}`);
}

if (worker.includes("/internal/v1/agent-tokens") || worker.includes("agent-token") || worker.includes("Agent Token")) {
  throw new Error("Console Agent governance must not expose Agent execution-token minting");
}
if (!worker.includes('fetchSite !== "same-origin"') || !worker.includes('origin !== url.origin')) {
  throw new Error("Agent governance mutations must remain exact same-origin");
}
if (!overlay.includes("Agent identity ≠ Agent authority") || !overlay.includes("不会创建 Delegation")) {
  throw new Error("Agent UI must explain identity/authority separation");
}
if (!overlay.includes("全局 Agent identity 状态变更") || !overlay.includes("confirmGlobalStatus")) {
  throw new Error("Agent global status updates require an explicit UI confirmation");
}
if (!applicationOverlay.includes("Agent identities")) {
  throw new Error("Application configuration UI must expose Agent identities");
}
if (!wrangler.includes('"main": "worker/external-connections.ts"') || !externalConnectionsWorker.includes('import downstreamWorker from "./agent-governance"')) {
  throw new Error("Console Worker entrypoint must preserve the Agent governance BFF in the bounded wrapper chain");
}

console.log("LifeSpace Console Agent governance boundary check passed");
