const $ = (id) => document.getElementById(id);
const views = {
  overview: ["账户总览", "管理你的身份、空间和授权入口。"],
  identity: ["我的账号", "查看跨应用统一的 LifeSpace 用户身份。"],
  spaces: ["我的空间", "了解自己加入的空间与成员角色。"],
  connections: ["连接与授权", "管理应用与外部系统访问你的授权。"],
  activity: ["活动记录", "查看身份、授权和操作审计的入口。"],
};
const state = { user: null, spaces: null, loading: false };
const roles = { owner: "所有者", admin: "管理员", editor: "编辑者", viewer: "查看者" };
function viewFromHash() {
  const name = location.hash.slice(1);
  return Object.hasOwn(views, name) ? name : "overview";
}
function navigate() {
  const name = viewFromHash();
  for (const node of document.querySelectorAll("[data-panel]")) node.hidden = node.dataset.panel !== name;
  for (const link of document.querySelectorAll("[data-view]")) {
    if (link.dataset.view === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("page-title").textContent = views[name][0];
  $("page-desc").textContent = views[name][1];
  document.title = views[name][0] + " · AISR Account";
}
async function api(path) {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || !Object.hasOwn(payload, "data")) {
    throw new Error(payload?.error?.message || "请求失败（HTTP " + res.status + "）");
  }
  return payload.data;
}
function put(id, text) { $(id).textContent = text; }
function renderIdentity(user) {
  state.user = user;
  put("header-user", user.displayName);
  put("greeting-name", user.displayName);
  put("account-name", user.displayName);
  put("account-id", user.id);
  put("identity-state", "已验证");
}
function renderSpaces(spaces) {
  state.spaces = spaces;
  put("space-count", String(spaces.length));
  const target = $("space-list");
  target.replaceChildren();
  if (!spaces.length) {
    const empty = document.createElement("p");
    empty.className = "list-message";
    empty.textContent = "当前账号没有已加入的空间。";
    target.append(empty);
    return;
  }
  for (const space of spaces) {
    const item = document.createElement("div");
    item.className = "space-item";
    const mark = document.createElement("span");
    mark.className = "space-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = space.name.slice(0, 1).toUpperCase();
    const info = document.createElement("div");
    info.className = "space-info";
    const title = document.createElement("strong");
    title.textContent = space.name;
    const meta = document.createElement("small");
    meta.textContent = space.id + " · " + space.timezone;
    info.append(title, meta);
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roles[space.role] || space.role;
    item.append(mark, info, role);
    target.append(item);
  }
}
async function load() {
  if (state.loading) return;
  state.loading = true;
  $("retry").disabled = true;
  $("session-error").hidden = true;
  try {
    const session = await api("/api/session");
    if (!session?.user || typeof session.user.displayName !== "string" || typeof session.user.id !== "string")
      throw new Error("账户身份响应不完整");
    renderIdentity(session.user);
    try {
      const spaces = await api("/api/account/spaces");
      if (!Array.isArray(spaces)) throw new Error("空间列表响应异常");
      renderSpaces(spaces);
    } catch (error) {
      put("space-count", "无法读取");
      put("space-list", error instanceof Error ? "无法读取空间：" + error.message : "暂时无法读取空间。");
    }
  } catch (error) {
    put("header-user", "身份尚未验证");
    put("greeting-name", "访客");
    put("identity-state", "不可用");
    put("account-name", "无法验证");
    put("account-id", "—");
    put("space-count", "—");
    put("space-list", "请先验证账号身份。");
    put("error-text", error instanceof Error ? error.message : "无法获取账户身份，请检查登录状态。");
    $("session-error").hidden = false;
  } finally {
    state.loading = false;
    $("retry").disabled = false;
  }
}
window.addEventListener("hashchange", navigate);
$("retry").addEventListener("click", load);
navigate();
void load();
