import { displayModelName, displayOperation, displayScope } from "./capability-labels.js";

const $ = (id) => document.getElementById(id);
const controls = { application: $("application"), space: $("space"), agent: $("agent") };
const state = { csrf: null, request: null, choices: [], busy: false, previewLoaded: false, previewVersion: 0 };
const requestId = new URL(location.href).searchParams.get("request_id");
const show = (id, yes) => $(id).classList.toggle("hidden", !yes);
function addOption(select, value, name) {
  const option = document.createElement("option"); option.value = value; option.textContent = name; select.append(option);
}
function failure(title, message) {
  show("content", false); show("loading", false); show("error", true);
  $("error-title").textContent = title; $("error-message").textContent = message;
}
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, credentials: "same-origin",
    headers: { accept: "application/json", ...(options.headers || {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !("data" in body)) {
    throw new Error(body?.error?.message || "请求失败（HTTP " + res.status + "）");
  }
  return body.data;
}
function updateButton() {
  const selected = state.choices.some((item) =>
    item.applicationId === controls.application.value
    && item.spaceId === controls.space.value && item.agentId === controls.agent.value);
  $("approve").disabled = !selected || !state.csrf || state.busy || !state.previewLoaded;
}
function resetCapabilities() {
  ++state.previewVersion;
  state.previewLoaded = false;
  $("capabilities").replaceChildren();
  $("capabilities").textContent = "选择 Agent 后查看当前可预览的数据类型。";
}
async function refreshCapabilities() {
  resetCapabilities();
  updateButton();
  if (!controls.application.value || !controls.space.value || !controls.agent.value) return;
  const version = state.previewVersion;
  $("capabilities").textContent = "正在读取 Agent 数据访问权限预览…";
  try {
    const projection = await api("/api/oauth/capabilities?" + new URLSearchParams({
      request_id: state.request.id,
      application_id: controls.application.value,
      space_id: controls.space.value,
      agent_id: controls.agent.value,
    }));
    if (version !== state.previewVersion) return;
    if (projection.kind !== "pre_policy_upper_bound" || !Array.isArray(projection.models)) {
      throw new Error("权限预览响应异常");
    }
    const node = $("capabilities");
    node.replaceChildren();
    if (!projection.models.length) {
      const p = document.createElement("p");
      p.textContent = "当前 Agent 暂无可预览的数据访问能力。";
      node.append(p);
    } else {
      for (const model of projection.models) {
        const line = document.createElement("div"); line.className = "capability-row";
        const name = document.createElement("span");
        name.className = "capability-name";
        name.textContent = displayModelName(model);
        name.title = "模型标识：" + model.key;
        line.append(name);
        for (const access of model.access) {
          const badge = document.createElement("span");
          badge.className = "access-chip";
          badge.textContent = displayOperation(access);
          badge.title = "操作代码：" + access;
          line.append(badge);
        }
        node.append(line);
      }
    }
    if (projection.truncated) {
      const note = document.createElement("p");
      note.textContent = "数据类型较多，仅显示部分权限预览。";
      node.append(note);
    }
    state.previewLoaded = true;
    updateButton();
  } catch (error) {
    if (version !== state.previewVersion) return;
    $("capabilities").textContent =
      "暂时无法获取权限预览。请重新选择 Agent 后重试。";
    updateButton();
  }
}

function updateAgents() {
  controls.agent.replaceChildren();
  const filtered = state.choices.filter((row) =>
    row.applicationId === controls.application.value && row.spaceId === controls.space.value);
  addOption(controls.agent, "", filtered.length ? "请选择执行 Agent" : "该空间没有可选 Agent");
  const unique = new Map(filtered.map((row) => [row.agentId, row.agentName]));
  for (const [id, name] of unique) addOption(controls.agent, id, name);
  controls.agent.disabled = !filtered.length;
  resetCapabilities();
  updateButton();
}
function updateSpaces() {
  controls.space.replaceChildren();
  const filtered = state.choices.filter((row) => row.applicationId === controls.application.value);
  const spaces = new Map(filtered.map((row) => [row.spaceId, row.spaceName]));
  addOption(controls.space, "", spaces.size ? "请选择你管理的空间" : "该应用暂无可授权的空间");
  for (const [id, name] of spaces) addOption(controls.space, id, name);
  controls.space.disabled = !spaces.size;
  updateAgents();
}
function updateApplications() {
  controls.application.replaceChildren();
  const applications = new Map(state.choices.map((row) => [row.applicationId, row.applicationName]));
  addOption(controls.application, "", applications.size ? "请选择 LifeSpace Application" : "暂无可用的 Application / Agent");
  for (const [id, name] of applications) addOption(controls.application, id, name);
  controls.application.disabled = !applications.size;
  updateSpaces();
}
async function initialize() {
  show("error", false); show("content", false); show("loading", true);
  if (!requestId || !/^oar_[A-Za-z0-9_-]{16,128}$/u.test(requestId)) {
    failure("授权请求无效", "请从需要连接的客户端重新发起 OAuth 授权。"); return;
  }
  try {
    const [session, oauth, choices] = await Promise.all([
      api("/api/session"),
      api("/api/oauth/request?request_id=" + encodeURIComponent(requestId)),
      api("/api/oauth/choices"),
    ]);
    if (!session?.csrfToken || !oauth?.client || !Array.isArray(choices?.candidates)) {
      throw new Error("缺少授权上下文");
    }
    state.csrf = session.csrfToken; state.request = oauth; state.choices = choices.candidates;
    $("client-title").textContent = oauth.client.name;
    $("redirect-origin").textContent = oauth.client.redirectOrigin;
    $("resource").textContent = oauth.resource;
    $("signed-user").textContent = "当前用户：" + session.user.displayName;
    $("scopes").replaceChildren();
    for (const scope of oauth.requestedScopes.length ? oauth.requestedScopes : ["未请求额外 Scope"]) {
      const span = document.createElement("span");
      span.textContent = displayScope(scope);
      span.title = scope;
      $("scopes").append(span);
    }
    updateApplications(); show("loading", false); show("content", true);
  } catch (err) {
    failure("暂时无法授权", err instanceof Error ? err.message : "身份或授权信息不可用");
  }
}
controls.application.addEventListener("change", updateSpaces);
controls.space.addEventListener("change", updateAgents);
controls.agent.addEventListener("change", refreshCapabilities);
document.querySelectorAll('input[name="mode"]').forEach((el) =>
  el.addEventListener("change", () => show("delegation-note", $("allow").checked)));
$("retry").addEventListener("click", initialize);
$("cancel").addEventListener("click", async () => {
  if (state.busy) return;
  if (!state.csrf || !state.request?.id) {
    failure("已停止授权", "没有创建 OAuth Authorization，你可以关闭此窗口。");
    return;
  }
  state.busy = true; updateButton();
  try {
    const result = await api("/api/oauth/deny", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lifespace-csrf": state.csrf },
      body: JSON.stringify({
        intent: "deny-oauth-authorization", requestId: state.request.id,
      }),
    });
    if (!result.redirectUrl || !/^https?:\/\//u.test(result.redirectUrl)) throw new Error("无效的 OAuth 回调地址");
    window.location.assign(result.redirectUrl);
  } catch (err) {
    state.busy = false;
    failure("拒绝授权未完成", err instanceof Error ? err.message : "请重新打开授权页面");
  }
});
$("approve").addEventListener("click", async () => {
  if ($("approve").disabled || !confirm("确认将所选 Application、Space 与 Agent 授权给此客户端？")) return;
  state.busy = true; updateButton(); $("approve").textContent = "正在确认…";
  try {
    const result = await api("/api/oauth/confirm", {
      method: "POST", headers: { "content-type": "application/json", "x-lifespace-csrf": state.csrf },
      body: JSON.stringify({
        intent: "confirm-oauth-authorization", requestId: state.request.id,
        applicationId: controls.application.value, spaceId: controls.space.value,
        agentId: controls.agent.value, allowUserAuthorization: $("allow").checked,
      }),
    });
    if (!result.redirectUrl || !/^https?:\/\//u.test(result.redirectUrl)) throw new Error("无效的 OAuth 回调地址");
    window.location.assign(result.redirectUrl);
  } catch (err) {
    alert(err instanceof Error ? err.message : "授权失败");
    state.busy = false; $("approve").textContent = "确认并继续 →"; updateButton();
  }
});
void initialize();
