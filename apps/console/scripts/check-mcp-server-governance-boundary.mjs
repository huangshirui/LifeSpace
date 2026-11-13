import { readFileSync } from "node:fs";
const core = readFileSync(new URL("../../core/src/mcp-server-governance.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/control-plane.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/McpServersPage.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../core/migrations/0078_mcp_server_simple_config.sql", import.meta.url), "utf8");

for (const source of [core, worker]) {
  if (!source.includes("mcp-servers") || !source.includes("platform-admin")) {
    throw new Error("MCP configuration governance has lost its privileged API boundary");
  }
}
for (const marker of [
  "requirePlatformAdminContext", "models:manage", "platform_admin_audit",
  "expectedRevision", "config_json", "revision=revision+1", "validateModels",
  "person_directory", "PERSON_OPERATIONS",
]) {
  if (!core.includes(marker)) throw new Error("Core MCP configuration missing " + marker);
}
for (const marker of [
  "exactSameOriginMutation", "x-lifespace-console-intent", "requireAdminContext",
  "mcpConfiguration", "enable-mcp-server", "disable-mcp-server", "confirmId",
]) {
  if (!worker.includes(marker)) throw new Error("MCP Console BFF missing " + marker);
}
if (/request\.headers\.get\(["']authorization["']\)/u.test(worker)) {
  throw new Error("MCP BFF must never forward browser bearer credentials");
}
for (const marker of [
  "CapabilityPicker", 'api<Model[]>("/api/models")',
  "configuration: config", "expectedRevision", "Person · 人员目录",
  "保存修改", "启用 Server", "停用 Server", "setCreating(false)",
  "创建 Server", "core.aisr.online",
]) {
  if (!ui.includes(marker)) throw new Error("MCP Server direct-edit experience missing " + marker);
}
if ((ui.match(/<CapabilityPicker /gu) ?? []).length !== 2) {
  throw new Error("New and edit MCP Server views must share the same capability editor");
}
if (!ui.includes('}, [serverKey, load]);')) {
  throw new Error("MCP Server create form must reset on route change");
}
const oauth = readFileSync(new URL("../src/OAuthClientAdmissionPage.tsx", import.meta.url), "utf8");
const controlPlane = readFileSync(new URL("../src/ControlPlaneApp.tsx", import.meta.url), "utf8");
const mcpReadDetail = ui.slice(ui.indexOf('className="mcp-read-fields"'));
const oauthReadDetail = oauth.slice(oauth.indexOf('return <div className="oad-page">'), oauth.indexOf('{editing && draft && <ConsoleDialog'));
for (const [source, label] of [[mcpReadDetail, "MCP"], [oauthReadDetail, "OAuth"]]) {
  if (!source || /<(?:input|textarea|select|CapabilityPicker)\b/u.test(source)) throw new Error(label + " read detail must not contain mutation fields");
}
for (const marker of ["onClick={beginEdit}", "onClick={cancelEdit}", "setEditing(false)", '<SearchableSelect label="选择模型或平台资源"']) {
  if (!ui.includes(marker)) throw new Error("MCP independent editor missing " + marker);
}
for (const marker of ['{editing && draft && <ConsoleDialog', "expectedRevision: current.revision", "onClose={cancelEdit}", "setEditing(false)"]) {
  if (!oauth.includes(marker)) throw new Error("OAuth independent editor missing " + marker);
}
if (!controlPlane.includes('<ConsoleDialog busy={busy} title="配置 Application × Model Access"') || !controlPlane.includes('confirmApplicationId: applicationId')) throw new Error("Model Access dedicated modal or confirmation missing");
for (const removed of [
  "publishedRevision", "draftRevision", "retryCreatePublish", "发布新版本",
  "保存草稿", "撤回发布", "published.manifest",
]) {
  if (ui.includes(removed)) throw new Error("Legacy Draft/Publish UI is still present: " + removed);
}
for (const marker of [
  "mcp_server_settings_v2", "json_patch(", "p.manifest_json", "DROP TABLE mcp_server_publications",
  "'78'", "schema_version",
]) {
  if (!migration.includes(marker)) throw new Error("Schema 78 migration is incomplete: " + marker);
}
console.log("MCP Server simple configuration boundary checks passed");
