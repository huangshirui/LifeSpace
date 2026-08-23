const environment = document.querySelector("#environment");
const sessionStatus = document.querySelector("#session-status");
const sessionContent = document.querySelector("#session-content");
const probeButton = document.querySelector("#probe-button");
const probeContent = document.querySelector("#probe-content");
const footerState = document.querySelector("#footer-state");

function text(element, value) {
  element.textContent = value;
}

function setEnvironment(value) {
  text(environment, value || "unknown");
  environment.className = `badge ${value === "production" ? "badge-danger" : value === "staging" ? "badge-warning" : "badge-neutral"}`;
}

function setSessionState(state) {
  sessionStatus.className = `status-dot ${state}`;
  sessionStatus.setAttribute("aria-label", state);
}

function row(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "data-row";
  const key = document.createElement("span");
  key.className = "data-key";
  key.textContent = label;
  const content = document.createElement("span");
  content.className = "data-value";
  content.textContent = value ?? "—";
  wrapper.append(key, content);
  return wrapper;
}

function errorMessage(payload, fallback) {
  return payload?.error?.message || fallback;
}

async function jsonRequest(path) {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  let payload = null;
  try { payload = await response.json(); }
  catch { payload = null; }
  return { response, payload };
}

async function loadSession() {
  setSessionState("loading");
  text(footerState, "resolving identity");
  const { response, payload } = await jsonRequest("/api/session");
  const data = payload?.data;
  if (data?.environment) setEnvironment(data.environment);

  sessionContent.replaceChildren();
  if (response.ok && data?.status === "linked") {
    setSessionState("success");
    sessionContent.append(
      row("User", data.user?.displayName || "—"),
      row("LifeSpace ID", data.user?.id || "—"),
      row("Status", data.user?.status || "—"),
      row("Console", data.consoleVersion || "—"),
    );
    probeButton.disabled = false;
    text(footerState, "identity linked");
    return;
  }

  if (response.status === 409 && data?.status === "unlinked") {
    setSessionState("warning");
    const title = document.createElement("strong");
    title.textContent = "Access 身份尚未绑定 LifeSpace 用户";
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = "LifeSpace 不会按邮箱自动创建或合并账户。完成显式账户绑定后再继续平台管理员验证。";
    sessionContent.append(title, message);
    text(footerState, "account link required");
    return;
  }

  setSessionState("error");
  const title = document.createElement("strong");
  title.textContent = "身份解析失败";
  const message = document.createElement("p");
  message.className = "muted";
  message.textContent = errorMessage(payload, `HTTP ${response.status}`);
  sessionContent.append(title, message);
  text(footerState, "identity unavailable");
}

function renderCheckGrid(checks) {
  const grid = document.createElement("div");
  grid.className = "check-grid";
  for (const [name, ok] of Object.entries(checks || {})) {
    const item = document.createElement("div");
    item.className = `check ${ok ? "check-success" : "check-error"}`;
    const mark = document.createElement("span");
    mark.textContent = ok ? "✓" : "×";
    const label = document.createElement("span");
    label.textContent = name;
    item.append(mark, label);
    grid.append(item);
  }
  return grid;
}

async function runProbe() {
  probeButton.disabled = true;
  probeButton.textContent = "验证中…";
  probeContent.replaceChildren();
  text(footerState, "probing control plane");

  const { response, payload } = await jsonRequest("/api/platform/probe");
  const data = payload?.data;
  probeContent.replaceChildren();

  if (!response.ok || !data?.ok) {
    const title = document.createElement("strong");
    title.textContent = response.status === 403 ? "当前用户没有平台管理员权限" : "控制面验证失败";
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = errorMessage(payload, `HTTP ${response.status}`);
    probeContent.append(title, message);
    probeButton.disabled = false;
    probeButton.textContent = "重新验证";
    text(footerState, "control-plane probe failed");
    return;
  }

  const summary = document.createElement("div");
  summary.className = "summary-grid";
  summary.append(
    row("Identity", `${data.contracts?.identity || "—"} / Admin ${data.contracts?.identityPlatformAdmin || "—"}`),
    row("Core", `${data.contracts?.coreKernel || "—"} / Admin ${data.contracts?.corePlatformAdmin || "—"}`),
    row("Schemas", `Identity ${data.schemas?.identity ?? "—"} · Core ${data.schemas?.core ?? "—"}`),
    row("Applications", String(data.counts?.applications ?? "—")),
    row("Models", String(data.counts?.publishedModels ?? "—")),
  );

  const safety = document.createElement("p");
  safety.className = "safety-line";
  safety.textContent = data.secretsExposedToBrowser === false && data.actorProofExposedToBrowser === false && data.mutationsPerformed === false
    ? "✓ Executor secret、Actor Proof 均未暴露给浏览器；本次 probe 未执行平台数据变更。"
    : "安全状态返回异常，请停止后续部署。";

  probeContent.append(summary, renderCheckGrid(data.checks), safety);
  probeButton.textContent = "验证通过";
  text(footerState, "control plane verified");
}

probeButton.addEventListener("click", () => {
  runProbe().catch((error) => {
    probeContent.replaceChildren();
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = error instanceof Error ? error.message : String(error);
    probeContent.append(message);
    probeButton.disabled = false;
    probeButton.textContent = "重新验证";
    text(footerState, "probe request failed");
  });
});

loadSession().catch((error) => {
  setSessionState("error");
  sessionContent.textContent = error instanceof Error ? error.message : String(error);
  text(footerState, "initialization failed");
});
