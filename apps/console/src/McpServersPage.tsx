import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "./mcp-servers.css";

type Operation = string;
type Selection = { modelKey: string; operations: Operation[] };
type ManifestModel = Selection & { modelVersion: number; schemaHash: string };
type Revision = { revision: number; manifestHash: string; publishedAt: string; publishedByUserId: string; manifest: { models: ManifestModel[] } };
type Server = {
  id: string; key: string; path: string; name: string; description: string;
  status: "draft" | "published" | "withdrawn";
  draftRevision: number; publishedRevision: number | null;
  draft: { models: Selection[] };
  published: { revision: number; manifest: { models: ManifestModel[] }; manifestHash: string; publishedAt: string } | null;
  createdAt: string; updatedAt: string;
};
type Model = { key: string; version: number; definition: { display?: { singular?: string }; access?: string[]; actions?: Record<string, { access?: string }> } };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
const names: Record<string,string> = {
  get: "读取单条", query: "查询", create: "创建", update: "更新", delete: "删除",
};
function label(op: string) { return names[op] ?? (op.startsWith("action:") ? "动作 · " + op.slice(7) : op); }
function endpoint(key: string, suffix = "") { return "/api/mcp-servers/" + encodeURIComponent(key) + suffix; }
function status(value: Server["status"]) { return { draft: "草稿", published: "已发布", withdrawn: "已撤回" }[value]; }
async function api<T>(path: string, method: "GET" | "POST" | "PATCH" = "GET", payload?: unknown, intent?: string): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { "content-type": "application/json", "x-lifespace-console-intent": intent ?? "" }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(payload ?? {}) }),
  });
  const data = await res.json().catch(() => null) as Envelope<T> | null;
  if (!res.ok) throw new Error(data?.error?.message ?? "请求失败（HTTP " + res.status + "）");
  if (!data || data.data === undefined) throw new Error("服务器返回格式错误");
  return data.data;
}
function operations(model: Model | undefined) {
  if (!model) return [] as string[];
  const access = model.definition.access ?? [];
  const result: string[] = [];
  if (access.includes("read")) result.push("query", "get");
  if (access.includes("write")) result.push("create", "update", "delete");
  for (const [action, details] of Object.entries(model.definition.actions ?? {})) {
    if ((details.access === "read" || details.access === "write") && access.includes(details.access)) {
      result.push("action:" + action);
    }
  }
  return result;
}
function sameDraft(a: Selection[], b: Selection[]) {
  const normalize = (items: Selection[]) => JSON.stringify(items.map((m) => ({
    modelKey: m.modelKey, operations: [...m.operations].sort(),
  })).sort((x,y) => x.modelKey.localeCompare(y.modelKey)));
  return normalize(a) === normalize(b);
}

export default function McpServersPage({ serverKey, navigate }: { serverKey?: string; navigate: (path: string) => void }) {
  const [rows, setRows] = useState<Server[]>([]);
  const [selected, setSelected] = useState<Server>();
  const [models, setModels] = useState<Model[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Selection[]>([]);
  const [newModel, setNewModel] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNotice("");
    try {
      const catalog = await api<Server[]>("/api/mcp-servers");
      setRows(catalog);
      if (serverKey) {
        const [server, modelCatalog, history] = await Promise.all([
          api<Server>(endpoint(serverKey)), api<Model[]>("/api/models"),
          api<Revision[]>(endpoint(serverKey, "/revisions")),
        ]);
        setSelected(server); setModels(modelCatalog); setRevisions(history);
        setName(server.name); setDescription(server.description);
        setDraft(server.draft.models.map((model) => ({ modelKey: model.modelKey, operations: [...model.operations] })));
      } else {
        setSelected(undefined);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setLoading(false); }
  }, [serverKey]);
  useEffect(() => { void load(); }, [load]);

  const modelMap = useMemo(() => new Map(models.map((model) => [model.key, model])), [models]);
  const dirty = Boolean(selected && (selected.name !== name || selected.description !== description || !sameDraft(selected.draft.models, draft)));
  const addChoices = models.filter((model) => !draft.some((item) => item.modelKey === model.key) && operations(model).length > 0);
  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate(async () => {
      const server = await api<Server>("/api/mcp-servers", "POST", {
        key: newKey.trim(), name: newName.trim(), description: newDescription.trim(),
      }, "create-mcp-server");
      setCreating(false); navigate(endpoint(server.key).replace("/api/", "/"));
    });
  }
  async function save() {
    if (!selected || !dirty) return;
    await mutate(async () => {
      const server = await api<Server>(endpoint(selected.key), "PATCH", {
        expectedDraftRevision: selected.draftRevision,
        name: name.trim(), description: description.trim(),
        draft: { models: draft },
      }, "edit-mcp-server");
      setSelected(server);
      setName(server.name); setDescription(server.description);
      setDraft(server.draft.models);
      setNotice("草稿已保存");
    });
  }
  async function publish() {
    if (!selected || dirty || draft.length === 0) return;
    if (!window.confirm("发布 " + selected.path + " 的新版本？")) return;
    await mutate(async () => {
      await api<Server>(endpoint(selected.key, "/publish"), "POST", {
        expectedDraftRevision: selected.draftRevision, confirmKey: selected.key,
      }, "publish-mcp-server");
      await load(); setNotice("发布成功，历史版本已保留");
    });
  }
  async function withdraw() {
    if (!selected || selected.status !== "published") return;
    if (!window.confirm("撤回 " + selected.path + " 的当前发布版本？")) return;
    await mutate(async () => {
      await api<Server>(endpoint(selected.key, "/withdraw"), "POST", { confirmKey: selected.key }, "withdraw-mcp-server");
      await load(); setNotice("已撤回发布");
    });
  }
  function addModel() {
    const model = modelMap.get(newModel);
    if (!model) return;
    const allowed = operations(model);
    if (!allowed.length) return;
    setDraft((value) => [...value, { modelKey: model.key, operations: [allowed[0]] }]);
    setNewModel("");
  }
  function toggle(key: string, op: string) {
    setDraft((value) => value.map((m) => {
      if (m.modelKey !== key) return m;
      const on = m.operations.includes(op);
      return { ...m, operations: on ? m.operations.filter((x) => x !== op) : [...m.operations, op] };
    }));
  }

  return <div className="mcp-page">
    <header className="mcp-header">
      <div>
        <div className="eyebrow">Platform</div>
        <h1>{serverKey && selected ? selected.name : "领域 MCP Servers"}</h1>
        <p>{serverKey && selected ? selected.path : "管理领域工具的模型与操作发布目录"}</p>
      </div>
      <div className="mcp-toolbar">
        {serverKey
          ? <button type="button" className="secondary-button" onClick={() => navigate("/mcp-servers")}>返回列表</button>
          : <button type="button" className="mcp-primary" onClick={() => setCreating((value) => !value)}>{creating ? "取消" : "新建 Server"}</button>}
      </div>
    </header>

    {error && <div className="mcp-message mcp-error" role="alert">{error}</div>}
    {notice && <div className="mcp-message mcp-success" role="status">{notice}</div>}
    {loading ? <div className="mcp-panel mcp-empty">正在加载…</div> : !serverKey ? <>
      {creating && <section className="mcp-panel">
        <h2>新建 MCP Server</h2>
        <form className="mcp-create" onSubmit={(event) => void create(event)}>
          <label>名称<input required minLength={2} maxLength={80} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="日常任务" /></label>
          <label>路径标识<input required pattern="[a-z][a-z0-9-]{1,39}" value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder="tasks" /></label>
          <p className="mcp-path">/mcp/{newKey || "…"}</p>
          <label className="mcp-full">描述（可选）<input maxLength={500} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="向客户端提供任务领域工具" /></label>
          <div className="mcp-full"><button type="submit" className="mcp-primary" disabled={busy}>创建草稿</button></div>
        </form>
      </section>}
      <section className="mcp-panel">
        <div className="mcp-table-scroll"><table className="mcp-table"><thead><tr><th>名称</th><th>路径</th><th>状态</th><th>版本</th><th /></tr></thead><tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong><small>{row.description}</small></td>
            <td><code>{row.path}</code></td>
            <td><span className={"mcp-state mcp-" + row.status}>{status(row.status)}</span></td>
            <td>{row.publishedRevision ? "v" + row.publishedRevision : "—"}</td>
            <td><button type="button" className="mcp-text-button" onClick={() => navigate("/mcp-servers/" + encodeURIComponent(row.key))}>管理</button></td>
          </tr>)}
        </tbody></table></div>
        {!rows.length && <div className="mcp-empty">尚无 MCP Server。点击右上角新建。</div>}
      </section>
      <p className="mcp-caption">发布会保存平台目录，不会自动部署 MCP Adapter 或创建客户端权限。</p>
    </> : selected ? <>
      <div className="mcp-summary">
        <div><span>状态</span><strong>{status(selected.status)}</strong></div>
        <div><span>已发布版本</span><strong>{selected.publishedRevision ? "v" + selected.publishedRevision : "—"}</strong></div>
        <div><span>草稿修订</span><strong>#{selected.draftRevision}</strong></div>
      </div>
      <section className="mcp-panel">
        <div className="mcp-panel-head"><h2>基本信息</h2><span>路径标识创建后不可修改</span></div>
        <div className="mcp-fields">
          <label>名称<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>路径<input value={selected.path} readOnly /></label>
          <label className="mcp-full">描述<input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </div>
      </section>
      <section className="mcp-panel">
        <div className="mcp-panel-head"><h2>模型与操作</h2><span>{draft.length} 个模型</span></div>
        {draft.map((item) => {
          const model = modelMap.get(item.modelKey);
          const capabilities = Array.from(new Set([...operations(model), ...item.operations]));
          return <div className="mcp-model" key={item.modelKey}>
            <div className="mcp-model-head"><div><strong>{model?.definition.display?.singular ?? item.modelKey}</strong><small>{item.modelKey}{model ? " · v" + model.version : " · 模型不可用"}</small></div>
              <button className="mcp-text-button" type="button" onClick={() => setDraft((value) => value.filter((m) => m.modelKey !== item.modelKey))}>移除</button>
            </div>
            <div className="mcp-operations">{capabilities.map((op) => <label key={op} className="mcp-check">
              <input type="checkbox" checked={item.operations.includes(op)} onChange={() => toggle(item.modelKey, op)} />
              {label(op)}{!operations(model).includes(op) && <em>已失效</em>}
            </label>)}</div>
          </div>;
        })}
        {!draft.length && <div className="mcp-empty mcp-small">请选择一个模型及其操作。</div>}
        <div className="mcp-add">
          <select aria-label="选择模型" value={newModel} onChange={(event) => setNewModel(event.target.value)}>
            <option value="">选择已发布模型</option>
            {addChoices.map((m) => <option value={m.key} key={m.key}>{m.definition.display?.singular ?? m.key} · {m.key}</option>)}
          </select>
          <button type="button" className="secondary-button" onClick={addModel} disabled={!newModel}>添加模型</button>
        </div>
      </section>
      <div className="mcp-actions">
        <button type="button" className="mcp-primary" disabled={busy || !dirty || draft.some((m) => !m.operations.length)} onClick={() => void save()}>保存草稿</button>
        <button type="button" className="secondary-button" disabled={busy || dirty || !draft.length} onClick={() => void publish()}>发布新版本</button>
        {selected.status === "published" && <button type="button" className="mcp-danger" disabled={busy} onClick={() => void withdraw()}>撤回发布</button>}
        {dirty && <span className="mcp-hint">请先保存草稿，再发布</span>}
      </div>
      <section className="mcp-panel">
        <h2>已发布版本</h2>
        {revisions.length ? <div className="mcp-table-scroll"><table className="mcp-table"><thead><tr><th>版本</th><th>发布时间</th><th>模型</th><th>摘要</th></tr></thead><tbody>
          {revisions.map((rev) => <tr key={rev.revision}>
            <td><strong>v{rev.revision}</strong></td>
            <td>{new Date(rev.publishedAt).toLocaleString("zh-CN")}</td>
            <td>{rev.manifest.models.map((m) => m.modelKey).join("、")}</td>
            <td><code title={rev.manifestHash}>{rev.manifestHash.slice(0, 12)}</code></td>
          </tr>)}
        </tbody></table></div> : <div className="mcp-empty">尚未发布。</div>}
        <p className="mcp-caption">历史版本不可修改。部署到 MCP Adapter 仍需独立集成与验证。</p>
      </section>
    </> : <div className="mcp-panel mcp-empty">找不到此 MCP Server。</div>}
  </div>;
}
