const byId = (id) => document.getElementById(id);
const selectors = { app: byId("application"), space: byId("space"), agent: byId("agent") };
const state = { csrfToken: null, request: null, candidates: [], submitting: false };
const requestId = new URL(window.location.href).searchParams.get("request_id");
const visible = (id, on) => byId(id).classList.toggle("hidden", !on);
const label = (el, value) => { el.textContent = value; };
function option(select, value, text) {
  const entry = document.createElement("option");
  entry.value = value;
  entry.textContent = text;
  select.append(entry);
}
function showError(title, message) {
  visible("loading", false);
  visible("content", false);
  visible("error", true);
  label(byId("error-title"), title);
  label(byId("error-message"), message);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options, credentials: "same-origin",
    headers: { accept: "application/json", ...(options.headers || {}) },
  });
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope || !("data" in envelope)) {
    const message = envelope && envelope.error && envelope.error.message
      ? envelope.error.message : "请求失败（HTTP " + response.status + "）";
    throw new Error(message);
  }
  return envelope.data;
}
function updateApprove() {
  const valid = state.candidates.some((x) =>
    x.applicationId === selectors.app.value && x.agentId === selectors.agent.value);
  byId("approve").disabled = !valid || !selectors.space.value || !state.csrfToken || state.submitting;
}
function setAgentOptions() {
  const appId = selectors.app.value;
  const agents = state.candidates.filter((x) => x.applicationId === appId);
  selectors.agent.replaceChildren();
  option(selectors.agent, "", agents.length ? "请选择执行 Agent" : "该应用没有可用 Agent");
  for (const entry of agents) option(selectors.agent, entry.agentId, entry.agentName);
  selectors.agent.disabled = !appId || !agents.length;
  updateApprove();
}
function setApplicationOptions() {
  const apps = new Map();
  for (const candidate of state.candidates) apps.set(candidate.applicationId, candidate.applicationName);
  selectors.app.replaceChildren();
  option(selectors.app, "", apps.size ? "请选择 LifeSpace Application" : "此空间暂没有可用 Agent");
  for (const [id, name] of apps) option(selectors.app, id, name);
  selectors.app.disabled = !apps.size;
  setAgentOptions();
}
async function selectSpace() {
  state.candidates = [];
  setApplicationOptions();
  if (!selectors.space.value) return;
  try {
    const result = await api("/api/oauth/options?space_id=" + encodeURIComponent(selectors.space.value));
    if (!Array.isArray(result.candidates)) throw new Error("Agent 列表格式异常");
    state.candidates = result.candidates;
    setApplicationOptions();
  } catch (error) {
    showError("无法读取可用 Agent", error instanceof Error ? error.message : "Agent 信息不可用");
  }
}
async function initialize() {
  visible("error", false); visible("content", false); visible("loading", true);
  if (!requestId || !/^oar_[A-Za-z0-9_-]{16,128}$/u.test(requestId)) {
    showError("缺少授权请求", "请从 ChatGPT、Claude 等客户端重新发起 OAuth 连接。");
    return;
  }
  try {
    const [session, oauth, spaces] = await Promise.all([
      api("/api/session"),
      api("/api/oauth/request?request_id=" + encodeURIComponent(requestId)),
      api("/api/oauth/spaces"),
    ]);
    if (!Array.isArray(spaces) || !oauth || !oauth.client) throw new Error("授权上下文不可用");
    state.csrfToken = session.csrfToken;
    state.request = oauth;
    label(byId("client-title"), oauth.client.name);
    label(byId("redirect-origin"), oauth.client.redirectOrigin);
    label(byId("resource"), oauth.resource);
    label(byId("signed-user"), "当前用户：" + session.user.displayName);
    byId("scopes").replaceChildren();
    const scopes = oauth.requestedScopes.length ? oauth.requestedScopes : ["未请求额外 Scope"];
    for (const scope of scopes) {
      const span = document.createElement("span");
      span.textContent = scope;
      byId("scopes").append(span);
    }
    selectors.space.replaceChildren();
    option(selectors.space, "", spaces.length ? "请选择你管理的空间" : "暂无可管理的空间");
    for (const space of spaces) option(selectors.space, space.id, space.name);
    setApplicationOptions();
    visible("loading", false); visible("content", true);
  } catch (error) {
    showError("无法继续授权", error instanceof Error ? error.message : "身份或授权请求不可用");
  }
}
selectors.space.addEventListener("change", selectSpace);
selectors.app.addEventListener("change", setAgentOptions);
selectors.agent.addEventListener("change", updateApprove);
document.querySelectorAll('input[name="mode"]').forEach((radio) =>
  radio.addEventListener("change", () => visible("delegation-note", byId("allow").checked)));
byId("retry").addEventListener("click", initialize);
byId("cancel").addEventListener("click", () =>
  showError("已取消授权", "未创建 OAuth Authorization。你可以关闭此页面并返回客户端。"));
byId("approve").addEventListener("click", async () => {
  if (byId("approve").disabled ||
    !window.confirm("确认将当前 Application、Space 与 Agent 授权给此客户端？")) return;
  state.submitting = true; updateApprove(); label(byId("approve"), "正在确认…");
  try {
    const result = await api("/api/oauth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lifespace-csrf": state.csrfToken },
      body: JSON.stringify({
        intent: "confirm-oauth-authorization", requestId: state.request.id,
        applicationId: selectors.app.value, spaceId: selectors.space.value,
        agentId: selectors.agent.value, allowUserAuthorization: byId("allow").checked,
      }),
    });
    if (!result.redirectUrl || !/^https?:\/\//u.test(result.redirectUrl)) {
      throw new Error("OAuth 回调地址无效");
    }
    window.location.assign(result.redirectUrl);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "授权失败");
    state.submitting = false; label(byId("approve"), "确认并继续 →"); updateApprove();
  }
});
void initialize();
