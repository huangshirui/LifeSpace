import { readFileSync } from "node:fs";
const core = readFileSync(new URL("../../core/src/mcp-server-governance.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/control-plane.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/McpServersPage.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../core/migrations/0077_mcp_server_registry.sql", import.meta.url), "utf8");

for (const source of [core, worker]) {
  for (const marker of ["platform-admin", "mcp-servers"]) {
    if (!source.includes(marker)) throw new Error("MCP governance missing " + marker);
  }
}
if (!core.includes("models:manage")) throw new Error("Core MCP governance must enforce models:manage");
if (!core.includes(".bind(serverId, serverId") || core.includes('rejectKeys(input, ["key"')) {
  throw new Error("Core must generate MCP Server ID and populate legacy schema-77 server_key internally");
}
if (ui.includes("newKey") || ui.includes("setNewKey") || ui.includes("selected.key") || ui.includes("confirmKey")) {
  throw new Error("MCP Server UI must not request a user-configured key");
}

for (const marker of [
  "requirePlatformAdminContext", "manifest_hash", "schema_hash",
  "draft_revision", "published_revision", "platform_admin_audit",
]) {
  if (!core.includes(marker)) throw new Error("Core MCP governance must retain " + marker);
}
for (const marker of ["exactSameOriginMutation", "x-lifespace-console-intent", "requireAdminContext", "confirmId", "mcpDraft", "mcpCore"]) {
  if (!worker.includes(marker)) throw new Error("Console MCP governance must retain " + marker);
}
if (/request\.headers\.get\(["']authorization["']\)/u.test(worker)) {
  throw new Error("MCP BFF must not forward browser bearer credentials");
}
// The create journey must configure models and operations before creating a Server,
// default to a two-stage create+publish, and never repeat create on a publish retry.
for (const marker of [
  "ModelSelectionEditor", "models={models} value={createDraft}", "onChange={setCreateDraft}",
  'api<Model[]>("/api/models")', 'draft: { models: createDraft }',
  'endpoint(server.id, "/publish")', "expectedDraftRevision: server.draftRevision",
  "confirmId: server.id", "setCreatedDraft(server)", "retryCreatePublish",
  "createdDraft.id", "创建并发布", "保存草稿", "管理草稿",
]) {
  if (!ui.includes(marker)) throw new Error("MCP create-and-publish journey missing " + marker);
}
if ((ui.match(/<ModelSelectionEditor /gu) ?? []).length !== 2) {
  throw new Error("MCP create/edit pages must share the same Model operation editor");
}
if (ui.includes(">创建草稿</button>")) {
  throw new Error("Empty draft creation must not be the only create action");
}
if ((ui.match(/api<Server>\("\/api\/mcp-servers", "POST"/gu) ?? []).length !== 1) {
  throw new Error("Retry publish must not create another MCP Server");
}
if (!ui.includes('void load();\n  }\n  async function create(')) {
  throw new Error("Cancelling creation must refresh any draft created before a publish failure");
}
for (const marker of ["create-mcp-server", "publish-mcp-server", "confirmId"]) {
  if (!worker.includes(marker)) throw new Error("MCP BFF missing create/publish flow " + marker);
}

for (const marker of ["draftRevision", "publishedRevision", "revisions", "模型与操作", "发布新版本", "撤回发布"]) {
  if (!ui.includes(marker)) throw new Error("MCP Server management journey missing " + marker);
}
for (const marker of [
  "mcp_server_publication_immutable_update", "mcp_server_publication_immutable_delete",
  "schema_version", "'77'",
]) {
  if (!migration.includes(marker)) throw new Error("MCP registry migration missing " + marker);
}
console.log("MCP domain Server governance boundary checks passed");
