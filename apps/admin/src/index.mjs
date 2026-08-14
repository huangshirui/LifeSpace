import { requireAccess } from "./access.mjs";
import { adminError, listPublishedModels, onboardApplication } from "./onboarding.mjs";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LifeSpace Admin</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #172033; }
    main { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 6px; font-size: 26px; }
    p { color: #667085; }
    .card { background: white; border: 1px solid #e4e7ec; border-radius: 14px; padding: 22px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 16px; }
    label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 6px; }
    input, select { width: 100%; box-sizing: border-box; border: 1px solid #d0d5dd; border-radius: 8px; padding: 9px 10px; background: white; }
    .check { display: flex; gap: 8px; align-items: center; font-weight: 500; }
    .check input { width: auto; }
    .scopes { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 8px 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eaecf0; padding: 10px 8px; text-align: left; font-size: 14px; }
    th { color: #667085; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
    button { border: 0; border-radius: 9px; background: #175cd3; color: white; font-weight: 700; padding: 10px 16px; cursor: pointer; }
    button:disabled { opacity: .5; cursor: progress; }
    pre { white-space: pre-wrap; word-break: break-word; background: #101828; color: #f2f4f7; padding: 16px; border-radius: 10px; overflow: auto; }
    .secret { border: 1px solid #f79009; background: #fffaeb; padding: 12px; border-radius: 8px; color: #7a2e0e; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .muted { color: #667085; font-size: 13px; }
    .error { color: #b42318; }
  </style>
</head>
<body>
<main>
  <header><h1>LifeSpace Admin</h1><p>Application Onboarding MVP · Cloudflare Access protected</p></header>
  <form id="form">
    <section class="card">
      <h2>注册应用</h2>
      <div class="grid">
        <div><label for="name">名称</label><input id="name" required maxlength="100" placeholder="例如：进球记录" /></div>
        <div><label for="clientType">客户端类型</label><select id="clientType"><option value="web">Web</option><option value="mini_program">Mini Program</option><option value="service">Service</option><option value="device">Device</option></select></div>
        <div><label for="ttl">用户 Token TTL（秒）</label><input id="ttl" type="number" min="300" max="3600" step="1" value="900" /></div>
      </div>
      <p><label class="check"><input id="trustedBackend" type="checkbox" checked /> 有可信后端/BFF（创建一次性 lsa_* 凭据）</label></p>
    </section>

    <section class="card">
      <h2>API Scope Ceiling</h2>
      <div id="scopes" class="scopes"></div>
      <p class="muted">这是应用可请求的最大稳定 scope；最终权限仍与 Model Access、Space/Data Grant 和 Model Policy 求交集。</p>
    </section>

    <section class="card">
      <h2>Model Access</h2>
      <p id="modelStatus" class="muted">正在读取已发布模型…</p>
      <table><thead><tr><th>Model</th><th>Route</th><th>允许访问</th></tr></thead><tbody id="models"></tbody></table>
    </section>

    <button id="submit" type="submit">Register Application</button>
  </form>

  <section id="result" class="card" hidden>
    <h2>注册结果</h2>
    <div id="resultBody"></div>
  </section>
</main>
<script>
const scopeOptions = [
  "profile:read", "profile:write",
  "spaces:read", "spaces:write", "spaces:manage",
  "resources:read", "resources:write", "resources:manage",
  "creation-drafts:read", "creation-drafts:write"
];
const defaults = new Set(["profile:read", "spaces:read", "resources:read", "resources:write"]);
const scopes = document.getElementById("scopes");
for (const scope of scopeOptions) {
  const label = document.createElement("label"); label.className = "check";
  const input = document.createElement("input"); input.type = "checkbox"; input.value = scope; input.checked = defaults.has(scope);
  label.append(input, document.createTextNode(scope)); scopes.append(label);
}

let publishedModels = [];
async function loadModels() {
  const response = await fetch("/api/models");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || "读取模型失败");
  publishedModels = payload.data;
  const body = document.getElementById("models"); body.textContent = "";
  for (const model of publishedModels) {
    const row = document.createElement("tr");
    const select = document.createElement("select"); select.dataset.modelKey = model.key;
    select.append(new Option("No access", ""));
    for (const access of ["read", "write", "manage"]) if (model.definition.access.includes(access)) select.append(new Option(access, access));
    row.innerHTML = \`<td><strong>\${model.key}</strong><div class="muted">\${model.display?.singular || ""}</div></td><td>/\${model.route}</td><td></td>\`;
    row.lastElementChild.append(select); body.append(row);
  }
  document.getElementById("modelStatus").textContent = publishedModels.length + " 个 published models";
}
loadModels().catch((error) => { document.getElementById("modelStatus").textContent = error.message; document.getElementById("modelStatus").className = "error"; });

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = document.getElementById("submit"); submit.disabled = true;
  const result = document.getElementById("result"); const resultBody = document.getElementById("resultBody"); result.hidden = false; resultBody.textContent = "注册中…";
  const allowedScopes = [...document.querySelectorAll("#scopes input:checked")].map((input) => input.value);
  const modelAccess = [...document.querySelectorAll("#models select")].filter((select) => select.value).map((select) => ({ modelKey: select.dataset.modelKey, maxAccess: select.value }));
  try {
    const response = await fetch("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      name: document.getElementById("name").value,
      clientType: document.getElementById("clientType").value,
      trustedBackend: document.getElementById("trustedBackend").checked,
      accessTokenTtlSeconds: Number(document.getElementById("ttl").value),
      allowedScopes, modelAccess
    }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "注册失败");
    const data = payload.data;
    resultBody.innerHTML = \`<p><strong>Application ID</strong><br><code>\${data.applicationId}</code></p>\` +
      (data.clientSecret ? \`<p><strong>Client Secret — 仅显示一次</strong></p><div class="secret">\${data.clientSecret}</div>\` : "") +
      \`<p><strong>Core</strong> \${data.coreUrl || "-"}<br><strong>Identity</strong> \${data.identityUrl || "-"}</p><pre>\${JSON.stringify({ allowedScopes: data.allowedScopes, modelAccess: data.modelAccess }, null, 2)}</pre>\`;
  } catch (error) {
    resultBody.innerHTML = '<p class="error"></p>'; resultBody.firstElementChild.textContent = error.message;
  } finally { submit.disabled = false; }
});
</script>
</body></html>`;
}

async function api(request, env) {
  let operator;
  try { operator = await requireAccess(request, env); }
  catch (error) { return json({ error: { code: "ACCESS_UNAUTHORIZED", message: error.message } }, 401); }

  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/models") {
      return json({ data: await listPublishedModels(env), operator: { email: operator.email } });
    }
    if (request.method === "POST" && url.pathname === "/api/applications") {
      const body = await request.json().catch(() => null);
      return json({ data: await onboardApplication(env, body, operator) }, 201);
    }
    return json({ error: { code: "NOT_FOUND", message: "Admin API route not found" } }, 404);
  } catch (error) {
    const mapped = adminError(error);
    return json(mapped.body, mapped.status);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env);
    if (request.method === "GET" && url.pathname === "/health") return json({ data: { status: "ok", service: "admin", environment: env.ENVIRONMENT ?? "local" } });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(html(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
