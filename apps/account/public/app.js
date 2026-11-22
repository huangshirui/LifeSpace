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
  const selected = state.choices.find((item) =>
    item.applicationId === controls.application.value
    && item.spaceId === controls.space.value && item.agentId === controls.agent.value);
  const requiresUserAuthorization=selected?.requiresUserAuthorization===true;
  $("direct").disabled=requiresUserAuthorization;
  if(requiresUserAuthorization)$("allow").checked=true;
  show("delegation-note",$("allow").checked);
  $("approve").disabled = !selected || !state.csrf || state.busy || !state.previewLoaded;
}
function resetCapabilities() {
  ++state.previewVersion;
  state.previewLoaded = false;
  $("capabilities").replaceChildren();
  $("capabilities").textContent = "选择 Agent 后查看此 MCP Server 的可用操作。";
}
async function refreshCapabilities() {
  resetCapabilities();
  updateButton();
  if (!controls.application.value || !controls.space.value || !controls.agent.value) return;
  const version = state.previewVersion;
  $("capabilities").textContent = "正在核对 MCP Server 与 Agent 当前权限…";
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
      p.textContent = "此 Agent 暂无独立的数据权限。若允许申请用户授权，仍需你单独确认 Delegation，才可代表你执行相应操作。";
      node.append(p);
    } else {
      for (const model of projection.models) {
        const line = document.createElement("div"); line.className = "capability-row";
        const name = document.createElement("span");
        name.className = "capability-name";
        name.textContent = displayModelName(model);
        name.title = "模型标识：" + model.key;
        line.append(name);
        for (const operation of model.operations) {
          const badge = document.createElement("span");
          badge.className = "access-chip";
          badge.textContent = displayOperation(operation);
          badge.title = "操作代码：" + operation;
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
      api("/api/oauth/choices?request_id=" + encodeURIComponent(requestId)),
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
async function resolveKnownAgent(){
  if(state.busy || !state.request?.id)return;
  const spaceId=$("known-space").value.trim();
  const agentId=$("known-agent-id").value.trim();
  const status=$("known-agent-status");
  if(!/^spc_[A-Za-z0-9_-]+$/u.test(spaceId)||!/^agt_[A-Za-z0-9_-]+$/u.test(agentId)){
    status.textContent="请输入完整的 Space ID 与 Agent ID。";return;
  }
  state.busy=true;
  $("lookup-known-agent").disabled=true;
  status.textContent="正在验证当前空间管理权限和 Agent 身份…";
  try{
    const result=await api("/api/oauth/choices?"+new URLSearchParams({
      request_id:state.request.id,space_id:spaceId,agent_id:agentId,
    }));
    const candidates=(result.candidates??[]).filter(row=>
      row.spaceId===spaceId && row.agentId===agentId && row.requiresUserAuthorization===true);
    if(!candidates.length)throw new Error("此空间没有可用的 Agent 身份绑定，请检查 ID 和访问权限。");
    const chosen=candidates[0];
    for(const candidate of candidates){
      if(!state.choices.some(row=>row.spaceId===candidate.spaceId
        &&row.applicationId===candidate.applicationId&&row.agentId===candidate.agentId)){
        state.choices.unshift(candidate);
      }
    }
    updateApplications();
    controls.application.value=chosen.applicationId;
    updateSpaces();
    controls.space.value=chosen.spaceId;
    updateAgents();
    controls.agent.value=chosen.agentId;
    $("allow").checked=true;
    await refreshCapabilities();
    status.textContent="已验证 Agent 与 Application；当前连接仅允许后续申请用户委托，未授予访问权限。";
    $("known-agent").open=false;
  }catch(error){
    status.textContent=error instanceof Error?error.message:"验证失败";
  }finally{
    state.busy=false;
    $("lookup-known-agent").disabled=false;
    updateButton();
  }
}
$("lookup-known-agent").addEventListener("click",()=>void resolveKnownAgent());
controls.application.addEventListener("change", updateSpaces);
controls.space.addEventListener("change", updateAgents);
controls.agent.addEventListener("change", refreshCapabilities);
document.querySelectorAll('input[name="mode"]').forEach((el) =>
  el.addEventListener("change", updateButton));
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
