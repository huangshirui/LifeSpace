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

async function postJsonRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-lifespace-console-intent": "register-staging-user",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let payload = null;
  try { payload = await response.json(); }
  catch { payload = null; }
  return { response, payload };
}

function renderRegistration(data) {
  const panel = document.createElement("div");
  panel.className = "registration-panel";

  const caution = document.createElement("p");
  caution.className = "registration-caution";
  caution.textContent = "仅当这个 Access 身份没有对应的 staging LifeSpace 用户时才创建。若你已经有 staging usr_*，不要使用此按钮；已有账户必须通过 proof-backed link challenge 绑定。";

  const field = document.createElement("label");
  field.className = "field";
  const fieldLabel = document.createElement("span");
  fieldLabel.textContent = "显示名称";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 50;
  input.autocomplete = "name";
  input.placeholder = "例如：Shirui";
  field.append(fieldLabel, input);

  const confirmLabel = document.createElement("label");
  confirmLabel.className = "confirm-line";
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  const confirmText = document.createElement("span");
  confirmText.textContent = "我确认当前 Access 身份没有对应的 staging LifeSpace 用户，并明确创建一个新的 staging 用户。";
  confirmLabel.append(confirm, confirmText);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "secondary";
  action.textContent = "创建 staging LifeSpace 用户";
  action.disabled = true;

  const feedback = document.createElement("p");
  feedback.className = "registration-feedback muted";

  function refreshButton() {
    action.disabled = !confirm.checked || !input.value.trim();
  }
  input.addEventListener("input", refreshButton);
  confirm.addEventListener("change", refreshButton);

  action.addEventListener("click", async () => {
    const displayName = input.value.trim();
    if (!displayName || !confirm.checked) return;
    action.disabled = true;
    input.disabled = true;
    confirm.disabled = true;
    action.textContent = "创建中…";
    feedback.textContent = "正在由 LifeSpace Identity 验证当前 Access assertion 并创建用户…";
    text(footerState, "registering staging identity");

    try {
      const { response, payload } = await postJsonRequest("/api/session/register", { displayName });
      if (response.ok && payload?.data?.user?.id) {
        feedback.textContent = `创建成功：${payload.data.user.id}`;
        await loadSession();
        return;
      }
      if (response.status === 409 && payload?.error?.code === "ACCESS_PRINCIPAL_ALREADY_LINKED") {
        await loadSession();
        return;
      }
      feedback.textContent = errorMessage(payload, `创建失败：HTTP ${response.status}`);
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
    }

    input.disabled = false;
    confirm.disabled = false;
    action.textContent = "重新创建";
    refreshButton();
    text(footerState, "staging identity registration failed");
  });

  panel.append(caution, field, confirmLabel, action, feedback);
  if (data?.registrationAvailable !== true) {
    action.disabled = true;
    input.disabled = true;
    confirm.disabled = true;
    feedback.textContent = "当前环境不开放 Console 首次注册。";
  }
  return panel;
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
    message.textContent = "LifeSpace 不会按邮箱自动创建或合并账户。你可以显式创建新的 staging 用户，或通过已有 LifeSpace 用户凭证完成 link challenge。";
    sessionContent.append(title, message, renderRegistration(data));
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
